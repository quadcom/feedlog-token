import { and, eq } from 'drizzle-orm'
import { z } from 'zod/v4'
import { appConnection, user } from '#layers/feedlog/server/db/schemas'
import { CONNECT_POLL_INTERVAL_SECONDS } from '#layers/feedlog/shared/constants/connect'

const schema = z.object({
  deviceCode: z.string().min(20).max(200),
})

// An app polling every 5 s makes 12 calls a minute; this leaves room for a few
// installations behind one address.
const RATE_LIMIT = { limit: 60, windowSeconds: 60 }

// POST /api/connect/poll — the app asks whether its code has been approved.
// Body: { deviceCode }. Always 200 with a `status`; see docs/connect-an-app.md.
//
// The device code travels in the body, never the URL: the access log records
// every path and query string.
export default defineEventHandler(async (event) => {
  const ip = getRequestIP(event, { xForwardedFor: true }) || 'unknown'
  if (!await checkRateLimit(`connect-poll:${ip}`, RATE_LIMIT)) {
    throw createError({
      statusCode: 429,
      message: 'Polling too fast. Wait the interval between polls.',
      data: { code: 'CONNECT_POLL_RATE_LIMITED' },
    })
  }

  const { deviceCode } = await readValidatedBody(event, schema.parse)
  const hash = hashDeviceCode(deviceCode)
  const db = useDB()

  const [row] = await db.select().from(appConnection)
    .where(eq(appConnection.deviceCodeHash, hash)).limit(1)

  // Unknown covers "already collected": the hash is cleared when the token is
  // handed over, so a second poll finds nothing.
  if (!row) return { status: 'expired' as const }

  if (row.codeExpiresAt.getTime() <= Date.now()) {
    await db.delete(appConnection).where(eq(appConnection.id, row.id))
    return { status: 'expired' as const }
  }

  if (row.status === 'pending') {
    return { status: 'pending' as const, interval: CONNECT_POLL_INTERVAL_SECONDS }
  }

  if (row.status !== 'approved' || !row.userId) {
    // Denied (or revoked by a manager before collection). Tell the app once,
    // then forget the code.
    await db.delete(appConnection).where(eq(appConnection.id, row.id))
    return { status: 'denied' as const }
  }

  // Claim the row before minting, conditionally on the hash still being there.
  // Two polls racing each other would otherwise both mint a session; this way
  // exactly one wins and the other sees `expired`.
  const [claimed] = await db.update(appConnection)
    .set({ deviceCodeHash: null, userCode: null })
    .where(and(eq(appConnection.id, row.id), eq(appConnection.deviceCodeHash, hash)))
    .returning({ id: appConnection.id })
  if (!claimed) return { status: 'expired' as const }

  // Banned between approving and collecting: no token.
  if (await isUserBanned(db, row.userId)) {
    await db.update(appConnection).set({ status: 'revoked', revokedAt: new Date() })
      .where(eq(appConnection.id, row.id))
    return { status: 'denied' as const }
  }

  const expiresAt = connectionExpiry()
  let minted: { id: string; token: string }
  try {
    minted = await mintConnectionSession(row.userId, { app: row.app, label: row.label, expiresAt })
  }
  catch (err) {
    // Leave no half-made connection behind; the app starts again.
    await db.update(appConnection).set({ status: 'revoked', revokedAt: new Date() })
      .where(eq(appConnection.id, row.id))
    throw err
  }

  await db.update(appConnection)
    .set({ status: 'connected', sessionId: minted.id, expiresAt })
    .where(eq(appConnection.id, row.id))

  const [person] = await db.select({ id: user.id, name: user.name, email: user.email })
    .from(user).where(eq(user.id, row.userId)).limit(1)

  // The only place a connection's raw token ever appears.
  return {
    status: 'connected' as const,
    token: minted.token,
    expiresAt: expiresAt.toISOString(),
    connectionId: row.id,
    user: person ?? { id: row.userId, name: null, email: null },
  }
})
