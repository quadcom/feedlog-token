// DELETE /api/connect/current — an app ends its own connection, when the person
// presses the app's Disconnect. Authenticated by the connection's bearer token,
// and the one write besides reporting that the guard lets a connection make.
// Without it an app could only forget its token locally, leaving it alive here.
export default defineEventHandler(async (event) => {
  const connection = await findBearerConnection(event)
  if (!connection) throw createError({ statusCode: 401, message: 'Authentication required' })
  await revokeConnections(useDB(), { id: connection.id }, connection.userId)
  setResponseStatus(event, 204)
  return null
})
