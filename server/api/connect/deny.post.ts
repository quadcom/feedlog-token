import { and, eq } from 'drizzle-orm'
import { appConnection } from '#layers/feedlog/server/db/schemas'

// POST /api/connect/deny — the signed-in person refuses the app. Body: { code }.
// The row is kept until the app's next poll tells it `denied`.
export default defineEventHandler(async (event) => {
  const { session, orgId } = await requireConnectingPerson(event)
  const body = await readBody<{ code?: unknown }>(event).catch(() => ({} as { code?: unknown }))
  const db = useDB()
  const row = await findPendingByUserCode(db, orgId, body?.code)
  if (!row) throw codeNotFound()
  await db.update(appConnection)
    .set({ status: 'denied', userId: session.user.id, userCode: null })
    .where(and(eq(appConnection.id, row.id), eq(appConnection.status, 'pending')))
  return { ok: true }
})
