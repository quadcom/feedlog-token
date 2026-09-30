import { eq } from 'drizzle-orm'
import { user } from '#layers/feedlog/server/db/schemas'

// POST /api/admin/people/:userId/unban — lift a ban (manager or owner). Their
// old sessions and connections stay ended; they sign in and connect again.
export default defineEventHandler(async (event) => {
  const { session, orgId, role } = await requireConnectionModerator(event)
  const userId = getRouterParam(event, 'userId')!
  const db = useDB()
  await assertMayActOn(db, { userId: session.user.id, orgId, role }, userId)
  await db.update(user)
    .set({ banned: false, banReason: null, banExpires: null })
    .where(eq(user.id, userId))
  logBurn('unban', session.user.id, userId)
  return { ok: true }
})
