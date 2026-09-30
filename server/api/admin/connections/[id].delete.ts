import { and, eq } from 'drizzle-orm'
import { appConnection } from '#layers/feedlog/server/db/schemas'

// DELETE /api/admin/connections/:id — cut off one connection (manager or owner),
// so one leaked server can be stopped without touching the person's others.
export default defineEventHandler(async (event) => {
  const { session, orgId, role } = await requireConnectionModerator(event)
  const id = getRouterParam(event, 'id')!
  const db = useDB()
  const [row] = await db.select({ userId: appConnection.userId }).from(appConnection)
    .where(and(eq(appConnection.id, id), eq(appConnection.orgId, orgId))).limit(1)
  if (!row?.userId) throw createError({ statusCode: 404, message: 'Connection not found' })
  await assertMayActOn(db, { userId: session.user.id, orgId, role }, row.userId)

  const count = await revokeConnections(db, { orgId, id }, session.user.id)
  if (!count) throw createError({ statusCode: 404, message: 'Connection not found' })
  logBurn('disconnect-one', session.user.id, row.userId, `connection=${id}`)
  setResponseStatus(event, 204)
  return null
})
