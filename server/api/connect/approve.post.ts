import { and, eq } from 'drizzle-orm'
import { appConnection } from '#layers/feedlog/server/db/schemas'

// POST /api/connect/approve — the signed-in person allows the app. Body: { code }.
// Nothing is minted here: the app collects its token at its next poll, straight
// from the server, so the credential never passes through this browser.
export default defineEventHandler(async (event) => {
  const { session, orgId } = await requireConnectingPerson(event)
  const body = await readBody<{ code?: unknown }>(event).catch(() => ({} as { code?: unknown }))
  const db = useDB()
  const row = await findPendingByUserCode(db, orgId, body?.code)
  if (!row) throw codeNotFound()

  // Conditional on still pending, so a code cannot be approved twice or approved
  // after being denied in another tab.
  const [updated] = await db.update(appConnection)
    .set({ status: 'approved', userId: session.user.id, approvedAt: new Date() })
    .where(and(eq(appConnection.id, row.id), eq(appConnection.status, 'pending')))
    .returning({ id: appConnection.id })
  if (!updated) throw codeNotFound()
  return { ok: true, app: row.app, label: row.label }
})
