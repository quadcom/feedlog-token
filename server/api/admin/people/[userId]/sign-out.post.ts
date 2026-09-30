// POST /api/admin/people/:userId/sign-out — end every session the person has,
// browser included (manager or owner). They sign in again, and connect their
// apps again.
export default defineEventHandler(async (event) => {
  const { session, orgId, role } = await requireConnectionModerator(event)
  const userId = getRouterParam(event, 'userId')!
  const db = useDB()
  await assertMayActOn(db, { userId: session.user.id, orgId, role }, userId)
  await endAllSessions(db, userId, session.user.id)
  logBurn('sign-out-everywhere', session.user.id, userId)
  return { ok: true }
})
