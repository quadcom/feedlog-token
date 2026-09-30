import { and, desc, eq, inArray } from 'drizzle-orm'
import { appConnection } from '#layers/feedlog/server/db/schemas'

// GET /api/connect — the signed-in person's own connected apps, newest first.
// Ended ones are listed too, so a person who finds StaXX has stopped posting can
// see that it was disconnected and when.
export default defineEventHandler(async (event) => {
  const { session, orgId } = await requireConnectingPerson(event)
  const rows = await useDB().select().from(appConnection)
    .where(and(
      eq(appConnection.orgId, orgId),
      eq(appConnection.userId, session.user.id),
      inArray(appConnection.status, ['connected', 'revoked']),
    ))
    .orderBy(desc(appConnection.createdAt))
    .limit(50)
  return { data: rows.map(connectionToView) }
})
