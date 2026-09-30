import { createHash } from 'node:crypto'
import type { H3Event } from 'h3'
import { and, eq, inArray, isNull, lt, or } from 'drizzle-orm'
import { appConnection, member, post, session as sessionTable, user } from '#layers/feedlog/server/db/schemas'
import {
  CONNECT_CODE_ALPHABET,
  CONNECT_CODE_LENGTH,
  CONNECT_SESSION_DAYS,
  type ConnectionStatus,
  normaliseUserCode,
} from '#layers/feedlog/shared/constants/connect'
import { isAgentEmail } from '#layers/feedlog/shared/constants/agent'

// App connections: a program acting as a real person, with that person's
// approval. See docs/connect-an-app.md for the contract and
// server/middleware/connect-guard.ts for what such a session may do.
//
// The credential is minted exactly as an agent token is (mintAgentSession, with
// its load-bearing 4th argument), but for the person's own user id — so cards
// and comments are theirs, notifications and subscriptions follow them, and
// every existing gate treats the app as the person. The narrowing happens in the
// guard, not here and not in the auth helpers.

type DB = ReturnType<typeof useDB>

export interface ConnectionView {
  id: string
  app: string
  label: string
  status: ConnectionStatus
  createdAt: string
  approvedAt: string | null
  expiresAt: string | null
  lastUsedAt: string | null
  revokedAt: string | null
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null
  return value instanceof Date ? value.toISOString() : value
}

export function connectionToView(row: typeof appConnection.$inferSelect): ConnectionView {
  return {
    id: row.id,
    app: row.app,
    label: row.label,
    status: row.status as ConnectionStatus,
    createdAt: iso(row.createdAt)!,
    approvedAt: iso(row.approvedAt),
    expiresAt: iso(row.expiresAt),
    lastUsedAt: iso(row.lastUsedAt),
    revokedAt: iso(row.revokedAt),
  }
}

// Rejection sampling over a byte stream: 256 is not a multiple of the alphabet's
// length, and a plain modulo would make the first few letters more likely.
export function generateUserCode(): string {
  const n = CONNECT_CODE_ALPHABET.length
  const ceiling = 256 - (256 % n)
  let out = ''
  while (out.length < CONNECT_CODE_LENGTH) {
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    for (const b of bytes) {
      if (b < ceiling && out.length < CONNECT_CODE_LENGTH) out += CONNECT_CODE_ALPHABET[b % n]
    }
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`
}

// 32 random bytes, base64url: 43 characters. The app's half of the secret; only
// its hash is stored.
export function generateDeviceCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return Buffer.from(bytes).toString('base64url')
}

export function hashDeviceCode(code: string): string {
  return createHash('sha256').update(code).digest('hex')
}

export function connectionExpiry(): Date {
  return new Date(Date.now() + CONNECT_SESSION_DAYS * 24 * 60 * 60 * 1000)
}

// The address the person's browser should open. BETTER_AUTH_URL first: behind a
// reverse proxy the request's own host can be the container's, not the board's.
export function publicBaseUrl(event: H3Event): string {
  const configured = process.env.BETTER_AUTH_URL
  if (configured) return configured.replace(/\/+$/, '')
  return getRequestURL(event, { xForwardedHost: true, xForwardedProto: true }).origin
}

// The raw session token a request carries as `Authorization: Bearer`, in the
// same forms the bearer plugin accepts: raw, or `token.signature` (possibly
// URL-encoded). Null when there is no bearer header.
export function bearerSessionToken(event: H3Event): string | null {
  const header = getHeader(event, 'authorization')
  if (!header || header.slice(0, 7).toLowerCase() !== 'bearer ') return null
  let token = header.slice(7).trim()
  if (!token) return null
  if (token.includes('%')) {
    try { token = decodeURIComponent(token) }
    catch { /* leave as sent */ }
  }
  return token.split('.')[0] || null
}

// The connection a bearer request is authenticated as, or null for every other
// kind of caller (browser, widget, agent token). One indexed join: session.token
// is unique, app_connection.session_id is unique.
//
// Keyed on the bearer header alone, not the session cookie, and that is sound:
// the only way to present a session as a cookie is in its signed form, which
// needs the server's secret. An app never receives it — the token is handed over
// raw, and a year-long session is never refreshed, so no response ever sets it
// as a cookie either.
export async function findBearerConnection(event: H3Event) {
  const token = bearerSessionToken(event)
  if (!token) return null
  const db = useDB()
  const [row] = await db
    .select({ connection: appConnection })
    .from(sessionTable)
    .innerJoin(appConnection, eq(appConnection.sessionId, sessionTable.id))
    .where(eq(sessionTable.token, token))
    .limit(1)
  return row?.connection ?? null
}

// A year-long session for the person, labelled with the app so better-auth's own
// session lists can tell it from a browser.
export async function mintConnectionSession(
  userId: string,
  input: { app: string; label: string; expiresAt: Date },
): Promise<{ id: string; token: string }> {
  const ctx = await auth.$context
  // 4th argument: see mintAgentSession — without overrideAll the expiry is
  // silently replaced by the 7-day default.
  const row = await ctx.internalAdapter.createSession(
    userId,
    false,
    { expiresAt: input.expiresAt, userAgent: `${input.app} (${input.label})` },
    true,
  )
  if (!row?.token) {
    throw createError({ statusCode: 500, message: 'Failed to mint connection session' })
  }
  return { id: row.id, token: row.token }
}

// End connections: delete their sessions (which is what stops access, on the
// very next request — bearer callers bypass the cookie cache), and keep the rows
// as `revoked` so the person and managers can still see what existed.
export async function revokeConnections(
  db: DB,
  where: { orgId?: string; userId?: string; id?: string },
  revokedBy: string | null,
): Promise<number> {
  // An empty filter would revoke every connection on the deployment.
  if (!where.userId && !where.id) throw new Error('revokeConnections needs a user or a connection')
  const conds = [inArray(appConnection.status, ['connected', 'approved', 'pending'])]
  if (where.orgId) conds.push(eq(appConnection.orgId, where.orgId))
  if (where.userId) conds.push(eq(appConnection.userId, where.userId))
  if (where.id) conds.push(eq(appConnection.id, where.id))
  const rows = await db
    .update(appConnection)
    .set({
      status: 'revoked',
      revokedAt: new Date(),
      revokedBy,
      userCode: null,
      deviceCodeHash: null,
    })
    .where(and(...conds))
    .returning({ sessionId: appConnection.sessionId })
  const sessionIds = rows.map(r => r.sessionId).filter((s): s is string => !!s)
  if (sessionIds.length) {
    await db.delete(sessionTable).where(inArray(sessionTable.id, sessionIds))
  }
  return rows.length
}

// Every session the person has, browser included. Sessions are not per-workspace,
// so neither is this. Connections are marked revoked first so their rows say what
// happened rather than silently pointing at nothing.
export async function endAllSessions(db: DB, userId: string, revokedBy: string) {
  await revokeConnections(db, { userId }, revokedBy)
  await db.delete(sessionTable).where(eq(sessionTable.userId, userId))
}

export async function isUserBanned(db: DB, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ banned: user.banned, banExpires: user.banExpires })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1)
  if (!row?.banned) return false
  return !row.banExpires || row.banExpires.getTime() > Date.now()
}

// Codes nobody finished with. Called from start, so the table tidies itself
// without a scheduled job.
export async function sweepStaleCodes(db: DB) {
  await db.delete(appConnection).where(and(
    inArray(appConnection.status, ['pending', 'approved', 'denied']),
    lt(appConnection.codeExpiresAt, new Date()),
  ))
}

// Last-used is advisory, so it is written at most hourly and never awaited by
// the request it describes.
export async function touchConnection(db: DB, id: string) {
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000)
  await db
    .update(appConnection)
    .set({ lastUsedAt: new Date() })
    .where(and(
      eq(appConnection.id, id),
      or(isNull(appConnection.lastUsedAt), lt(appConnection.lastUsedAt, hourAgo)),
    ))
}

// Browser-only endpoints (approve, deny, the person's own list) refuse any
// request carrying a bearer header, so a connection can never approve another
// and an agent token can never approve anything.
export function assertBrowserRequest(event: H3Event) {
  if (getHeader(event, 'authorization')) {
    throw createError({ statusCode: 403, message: 'Sign in in a browser to do this' })
  }
}

// The signed-in person behind a browser-only connect endpoint. A real, local
// account in a browser: no bearer header (so no app, agent or widget token), no
// guest, no product-SSO session (an SSO email was asserted by another system,
// verified by nobody, and a year-long credential should not rest on that).
export async function requireConnectingPerson(event: H3Event) {
  assertBrowserRequest(event)
  const session = await requireLocalSession(event)
  if (isAgentEmail(session.user.email)) {
    throw createError({ statusCode: 403, message: 'Sign in in a browser to do this' })
  }
  const orgId = event.context.orgId
  if (!orgId) throw createError({ statusCode: 404, message: 'No workspace at this address' })
  return { session, orgId }
}

// A code still waiting for its person, in this workspace.
export async function findPendingByUserCode(db: DB, orgId: string, input: unknown) {
  const code = normaliseUserCode(typeof input === 'string' ? input : null)
  if (!code) return null
  const [row] = await db.select().from(appConnection)
    .where(and(
      eq(appConnection.userCode, code),
      eq(appConnection.orgId, orgId),
      eq(appConnection.status, 'pending'),
    ))
    .limit(1)
  if (!row || row.codeExpiresAt.getTime() <= Date.now()) return null
  return row
}

export function codeNotFound(): Error {
  return createError({
    statusCode: 404,
    message: 'That code is not valid any more. Start again from the app.',
    data: { code: 'CONNECT_CODE_NOT_FOUND' },
  })
}

// Staff side: the Members page's Connected apps section.
//
// Manager or owner, in a browser. Bearer callers are refused even with a manager
// role: burning someone's access or banning them is a person's decision, not
// something an agent token should be able to do on its own.
export async function requireConnectionModerator(event: H3Event) {
  assertBrowserRequest(event)
  const { session, orgId } = await requireOrgPermission(event, { feedlog: ['moderate'] })
  const orgList = (session as { orgList?: { orgId: string; role: string }[] }).orgList
  const role = orgList?.find(o => o.orgId === orgId)?.role ?? null
  return { session, orgId, role }
}

// Who a moderator may act on: someone this workspace knows (a member, or a
// person with a connection or a card here), never an owner unless the actor is
// one, and never themself. Signing yourself out everywhere is merely odd, but
// banning yourself would lock you out with nobody to undo it.
export async function assertMayActOn(
  db: DB,
  actor: { userId: string; orgId: string; role: string | null },
  targetUserId: string,
) {
  if (targetUserId === actor.userId) {
    throw createError({ statusCode: 400, message: 'You cannot do this to yourself' })
  }
  const [target] = await db.select({ id: user.id, email: user.email }).from(user)
    .where(eq(user.id, targetUserId)).limit(1)
  if (!target) throw createError({ statusCode: 404, message: 'Person not found' })
  if (isAgentEmail(target.email)) {
    throw createError({ statusCode: 400, message: 'Agents are managed under Developer, Agent tokens' })
  }

  const [membership] = await db.select({ role: member.role }).from(member)
    .where(and(eq(member.organizationId, actor.orgId), eq(member.userId, targetUserId))).limit(1)
  if (membership?.role === 'owner' && actor.role !== 'owner') {
    throw createError({ statusCode: 403, message: 'Only an owner can do this to an owner' })
  }
  if (membership) return

  const [connected] = await db.select({ id: appConnection.id }).from(appConnection)
    .where(and(eq(appConnection.orgId, actor.orgId), eq(appConnection.userId, targetUserId))).limit(1)
  if (connected) return
  const [authored] = await db.select({ id: post.id }).from(post)
    .where(and(eq(post.orgId, actor.orgId), eq(post.authorId, targetUserId))).limit(1)
  if (!authored) throw createError({ statusCode: 404, message: 'Person not found' })
}

// There is no audit table in this codebase (the "activity trail" elsewhere is a
// card's own comment history), so burns go to the container log, which is kept.
// One line, no token, nothing a reader could replay.
export function logBurn(action: string, actorId: string, targetId: string, detail?: string) {
  console.info(`[connect] ${action} target=${targetId} by=${actorId}${detail ? ` ${detail}` : ''}`)
}
