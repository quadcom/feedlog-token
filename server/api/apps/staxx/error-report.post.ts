import type { H3Event } from 'h3'
import { createHash, randomBytes } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod/v4'
import { board, post, postSearch, staxxErrorServer, staxxErrorShape, staxxErrorSighting, user } from '#layers/feedlog/server/db/schemas'

// POST /api/apps/staxx/error-report — StaXX reports a Docker Compose error it
// has no plain-English explanation for (local/PLAN-error-intake.md, section 2).
// No session: any StaXX server may send one. Nothing a shipped program holds can
// stay secret, so what protects the board is how narrow this intake is, and that
// the board it writes to is hidden (visibility 'staff').

const BOARD_NAME = 'Error explanations'
const PER_SERVER_PER_DAY = 10
const PER_ADDRESS_PER_DAY = 30
const DAY_SECONDS = 86_400

const schema = z.strictObject({
  serverId: z.string().regex(/^[0-9a-f]{32}$/, 'serverId is not one this intake issued').optional(),
  shape: z.string().min(10).max(300),
  staxxVersion: z.string().regex(/^\d{2}\.\d{2}\.\d{2}/),
  composeVersion: z.string().regex(/^v?\d+\.\d+\.\d+$/),
})

// StaXX removes these before sending, so finding one means the sender is not
// StaXX (or is, and failed to) — either way it must not reach the board.
const FORBIDDEN: Array<[RegExp, string]> = [
  [/[^\s@]+@[^\s@]+\.[^\s@]+/, 'an email address'],
  [/https?:\/\//i, 'a web address'],
  [/\b\d{1,3}(?:\.\d{1,3}){3}\b/, 'an IPv4 address'],
  // A bare '::' in ordinary text is not an address; hex groups around colons are.
  [/(?<![0-9a-f:])(?:(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}|[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6}::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?|::[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})(?![0-9a-f:])/i, 'an IPv6 address'],
]

function shapeProblem(shape: string): string | null {
  // Control and format characters cover newlines, tabs, NUL and bidi tricks.
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(shape)) return 'shape must be one line of printable text'
  for (const [re, what] of FORBIDDEN) {
    if (re.test(shape)) return `shape must not contain ${what}`
  }
  return null
}

function cardBody(shape: string, o: { staxxVersion: string; composeVersion: string; first: string; servers: number }) {
  return [
    'Docker Compose said (names, paths and addresses removed by StaXX):',
    '',
    `    ${shape}`,
    '',
    `StaXX version: ${o.staxxVersion}`,
    `Docker Compose version: ${o.composeVersion}`,
    `First seen: ${o.first}`,
    `Servers that met it: ${o.servers}`,
  ].join('\n')
}

// This route is anonymous, so the address limit is only as good as the address.
// The first X-Forwarded-For entry is whatever the sender wrote; a proxy only
// appends the real peer at the END. So prefer X-Real-IP (Nginx Proxy Manager
// sets it to the real client, overwriting any value sent), then the last
// X-Forwarded-For entry, then the socket address.
function sourceAddress(event: H3Event): string {
  const real = getRequestHeader(event, 'x-real-ip')?.trim()
  if (real) return real
  const last = getRequestHeader(event, 'x-forwarded-for')?.split(',').pop()?.trim()
  return last || getRequestIP(event) || 'unknown'
}

const shapeQueue = new Map<string, Promise<unknown>>()
function serialiseByShape<T>(hash: string, work: () => Promise<T>): Promise<T> {
  const run = (shapeQueue.get(hash) ?? Promise.resolve()).catch(() => {}).then(work)
  const tail = run.catch(() => {})
  shapeQueue.set(hash, tail)
  tail.then(() => { if (shapeQueue.get(hash) === tail) shapeQueue.delete(hash) })
  return run
}

export default defineEventHandler(async (event) => {
  const orgId = event.context.orgId
  if (!orgId) throw createError({ statusCode: 404, message: 'No workspace at this address' })

  const ip = sourceAddress(event)
  if (!await checkRateLimit(`staxx-error-ip:${ip}`, { limit: PER_ADDRESS_PER_DAY, windowSeconds: DAY_SECONDS })) {
    throw createError({ statusCode: 429, message: 'Too many reports from this address today. Try again tomorrow.' })
  }

  const body = await readValidatedBody(event, schema.parse)
  const problem = shapeProblem(body.shape)
  if (problem) throw createError({ statusCode: 400, message: problem })

  const db = useDB()
  const serverId = body.serverId ?? randomBytes(16).toString('hex')

  const [known] = await db.select().from(staxxErrorServer).where(eq(staxxErrorServer.id, serverId)).limit(1)
  // A blocked server is told it worked, so it learns nothing to work around.
  if (known?.blocked) return { ok: true, serverId }

  if (!await checkRateLimit(`staxx-error-server:${serverId}`, { limit: PER_SERVER_PER_DAY, windowSeconds: DAY_SECONDS })) {
    throw createError({ statusCode: 429, message: 'Too many reports from this server today. Try again tomorrow.' })
  }

  // Everything below needs the board and the reporter; refuse clearly before
  // recording the server so a misconfigured deployment does not eat the quota.
  const reporterId = process.env.STAXX_REPORTER_USER_ID
  if (!reporterId) {
    console.error('[staxx-error] STAXX_REPORTER_USER_ID is not set; reports cannot be filed')
    throw createError({ statusCode: 503, message: 'Error reports are not set up on this server.' })
  }
  const [reporter] = await db.select({ id: user.id }).from(user).where(eq(user.id, reporterId)).limit(1)
  const [errBoard] = await db.select({ id: board.id, visibility: board.visibility }).from(board)
    .where(and(eq(board.orgId, orgId), eq(board.name, BOARD_NAME))).limit(1)
  // A public board of that name must never receive these cards.
  if (!reporter || !errBoard || errBoard.visibility !== 'staff') {
    console.error(`[staxx-error] ${!reporter ? 'STAXX_REPORTER_USER_ID names no user' : !errBoard ? `no board called "${BOARD_NAME}"` : `board "${BOARD_NAME}" is not staff-only`}`)
    throw createError({ statusCode: 503, message: 'Error reports are not set up on this server.' })
  }

  const now = new Date()
  await db.insert(staxxErrorServer)
    .values({ id: serverId, lastSeenAt: now, lastAddress: ip.slice(0, 64), reportCount: 1 })
    .onConflictDoUpdate({
      target: staxxErrorServer.id,
      set: { lastSeenAt: now, lastAddress: ip.slice(0, 64), reportCount: sql`${staxxErrorServer.reportCount} + 1` },
    })

  const hash = createHash('sha256').update(body.shape).digest('hex')
  const today = now.toISOString().slice(0, 10)
  const meta = { staxxVersion: body.staxxVersion, composeVersion: body.composeVersion }

  // Reports of one shape are handled one at a time, so two first reports of the
  // same shape cannot each file a card. No database transaction is held across
  // the work: createPostRecord opens its own connections, so a transaction that
  // held one while waiting for another could stall a busy pool. The queue is
  // per process; a second app instance could in theory file one duplicate card,
  // which is harmless (the shape row keeps the first).
  const filed = await serialiseByShape(hash, async () => {
    const [row] = await db.select().from(staxxErrorShape).where(eq(staxxErrorShape.hash, hash)).limit(1)

    if (row) {
      // Servers-seen counts a server once per shape: the sighting row is the
      // record, and only the insert that wins bumps the count.
      const [fresh] = await db.insert(staxxErrorSighting).values({ serverId, hash }).onConflictDoNothing().returning({ hash: staxxErrorSighting.hash })
      const firstFromThisServer = !!fresh
      const servers = row.serversSeen + (firstFromThisServer ? 1 : 0)
      await db.update(staxxErrorShape).set({ serversSeen: servers, lastSeenAt: now, reportCount: sql`${staxxErrorShape.reportCount} + 1` }).where(eq(staxxErrorShape.hash, hash))
      if (firstFromThisServer) {
        const [card] = await db.select({ title: post.title, content: post.content }).from(post).where(eq(post.id, row.postId)).limit(1)
        if (card) {
          const content = card.content.replace(/^Servers that met it: \d+$/m, `Servers that met it: ${servers}`)
          const searchText = stripMarkdown(card.title + '\n' + content)
          await db.update(post).set({ content, excerpt: generateExcerpt(content), contentHash: computeContentHash(card.title, content) })
            .where(eq(post.id, row.postId))
          await db.insert(postSearch).values({ postId: row.postId, orgId, searchText })
            .onConflictDoUpdate({ target: postSearch.postId, set: { searchText } })
        }
      }
      return null
    }

    const created = await createPostRecord({
      orgId,
      authorId: reporterId,
      title: `Explain: ${body.shape}`.slice(0, 200),
      content: cardBody(body.shape, { ...meta, first: today, servers: 1 }),
      boardId: errBoard.id,
      subscribeAuthor: false,
    })
    await db.insert(staxxErrorSighting).values({ serverId, hash }).onConflictDoNothing()
    await db.insert(staxxErrorShape).values({ hash, postId: created.id, shape: body.shape, firstSeenAt: now, lastSeenAt: now, serversSeen: 1, reportCount: 1 }).onConflictDoNothing()
    return created
  })

  // After the card and its shape row exist, so listeners are never told of a card that is not there.
  if (filed) {
    publishDomainEvent(event, createDomainEvent({
      name: 'feedback.created',
      orgId,
      userId: reporterId,
      data: { feedbackId: filed.id, boardId: filed.boardId, source: 'portal', messageId: null },
    }))
  }

  return { ok: true, serverId }
})
