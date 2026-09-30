// POST /api/admin/people/:userId/disconnect-apps — end every app connection the
// person has here (manager or owner). Their browser sign-in is left alone: the
// leak was the app's token, not their account.
export default defineEventHandler(async (event) => {
  const { session, orgId, role } = await requireConnectionModerator(event)
  const userId = getRouterParam(event, 'userId')!
  const db = useDB()
  await assertMayActOn(db, { userId: session.user.id, orgId, role }, userId)
  const count = await revokeConnections(db, { orgId, userId }, session.user.id)
  logBurn('disconnect-apps', session.user.id, userId, `count=${count}`)
  return { ok: true, count }
})
