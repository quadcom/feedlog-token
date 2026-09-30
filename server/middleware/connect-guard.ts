import { and, eq } from 'drizzle-orm'
import { member } from '#layers/feedlog/server/db/schemas'
import { CONNECT_CARDS_PER_HOUR } from '#layers/feedlog/shared/constants/connect'

// Holds a connected app to reporting, whatever its person's role.
//
// A connection is the person's own session (docs/connect-an-app.md), so every
// route already treats it as them — which, for a manager, would include
// moderation. Narrowing it below the account's role without touching the auth
// helpers is done here, by path, for the reason sso-auth-guard gives: a list
// kept in one place stays right as routes are added, and anything not on it is
// refused rather than allowed.
//
// Only requests carrying a bearer header are looked at, and only those whose
// session belongs to an app_connection row are narrowed; browsers, the widget
// and agent tokens pass straight through.

// What a connection may write. Everything else that is not a read is refused.
const ALLOWED_WRITES: { method: string; re: RegExp }[] = [
  { method: 'POST', re: /^\/api\/posts$/ }, // create a card
  { method: 'POST', re: /^\/api\/posts\/similar$/ }, // similar-cards check
  { method: 'POST', re: /^\/api\/upload$/ }, // a picture for the card
  { method: 'POST', re: /^\/api\/posts\/[^/]+\/comments$/ }, // comment
  { method: 'POST', re: /^\/api\/posts\/[^/]+\/attachments$/ }, // private diagnostic file
  { method: 'DELETE', re: /^\/api\/connect\/current$/ }, // end this connection
  // Public anyway; allowed so an app that sends its old token on every call can
  // still start a fresh connection.
  { method: 'POST', re: /^\/api\/connect\/(start|poll)$/ },
]

// Reads that are still refused. Staff surfaces, and better-auth's own endpoints:
// list-sessions alone would hand an app every session token its person has,
// browser included. get-session is the one it needs, to check it is connected.
const REFUSED_READ_PREFIXES = ['/api/admin', '/api/developer', '/api/connect']
const ALLOWED_AUTH_READS = new Set(['/api/auth/get-session'])

const CARD_CREATE = /^\/api\/posts$/
const EXEMPT_ROLES = new Set(['owner', 'manager'])

// Compare on a canonical form, so /API//Admin/ or a percent-encoded letter
// cannot slip past a prefix check. The router itself is stricter than this, so
// canonicalising can only make the guard refuse more, never allow more.
function canonicalPath(path: string): string {
  let p = path.split('?')[0] ?? path
  try { p = decodeURIComponent(p) }
  catch { /* keep as sent */ }
  p = p.toLowerCase().replace(/\/{2,}/g, '/')
  if (p.length > 1) p = p.replace(/\/+$/, '')
  return p
}

function isAllowed(method: string, path: string): boolean {
  if (method === 'GET' || method === 'HEAD') {
    if (!path.startsWith('/api/')) return true
    if (path.startsWith('/api/auth/') || path === '/api/auth') return ALLOWED_AUTH_READS.has(path)
    return !REFUSED_READ_PREFIXES.some(prefix => path === prefix || path.startsWith(`${prefix}/`))
  }
  if (method === 'OPTIONS') return true
  return ALLOWED_WRITES.some(w => w.method === method && w.re.test(path))
}

function secondsToNextHour(): number {
  return 3600 - (Math.floor(Date.now() / 1000) % 3600)
}

export default defineEventHandler(async (event) => {
  if (!getHeader(event, 'authorization')) return

  const connection = await findBearerConnection(event)
  if (!connection) return

  const method = event.method.toUpperCase()
  const path = canonicalPath(event.path)

  if (!isAllowed(method, path)) {
    throw createError({
      statusCode: 403,
      message: 'A connected app can only read the board, post cards, comments and pictures.',
      data: { code: 'CONNECTED_APP_FORBIDDEN' },
    })
  }

  const db = useDB()
  // Fire and forget: last-used is advisory and must not slow the request.
  touchConnection(db, connection.id).catch(() => {})

  if (method === 'POST' && CARD_CREATE.test(path) && connection.userId) {
    const [row] = await db.select({ role: member.role }).from(member)
      .where(and(eq(member.organizationId, connection.orgId), eq(member.userId, connection.userId)))
      .limit(1)
    if (row && EXEMPT_ROLES.has(row.role)) return

    // Counted per person across all their connections, and counted on the
    // attempt: a card refused later for a bad body still uses a slot. Clock-hour
    // windows (checkRateLimit is fixed-window), hence Retry-After to the hour.
    const withinLimit = await checkRateLimit(`connect-cards:${connection.userId}`, {
      limit: CONNECT_CARDS_PER_HOUR,
      windowSeconds: 3600,
    })
    if (!withinLimit) {
      setResponseHeader(event, 'Retry-After', secondsToNextHour())
      throw createError({
        statusCode: 429,
        message: `You have sent ${CONNECT_CARDS_PER_HOUR} reports this hour. Try again later.`,
        data: { code: 'CONNECT_RATE_LIMITED' },
      })
    }
  }
})
