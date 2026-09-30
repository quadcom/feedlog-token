// POST /api/connect/lookup — the connect page asks what a code is for, so the
// person sees "Connect StaXX on Tower?" before deciding. Body: { code }.
// A POST so the code stays out of the access log's query strings.
export default defineEventHandler(async (event) => {
  const { orgId } = await requireConnectingPerson(event)
  const body = await readBody<{ code?: unknown }>(event).catch(() => ({} as { code?: unknown }))
  const row = await findPendingByUserCode(useDB(), orgId, body?.code)
  if (!row) throw codeNotFound()
  return {
    userCode: row.userCode,
    app: row.app,
    label: row.label,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.codeExpiresAt.toISOString(),
  }
})
