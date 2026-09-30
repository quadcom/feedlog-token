// DELETE /api/connect/:id — the person disconnects one of their own apps.
export default defineEventHandler(async (event) => {
  const { session, orgId } = await requireConnectingPerson(event)
  const id = getRouterParam(event, 'id')!
  const count = await revokeConnections(useDB(), { orgId, userId: session.user.id, id }, session.user.id)
  if (!count) throw createError({ statusCode: 404, message: 'Connection not found' })
  setResponseStatus(event, 204)
  return null
})
