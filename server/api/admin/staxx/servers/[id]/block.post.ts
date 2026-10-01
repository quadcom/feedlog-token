import { eq } from 'drizzle-orm'
import { staxxErrorServer } from '#layers/feedlog/server/db/schemas'

// POST /api/admin/staxx/servers/:id/block — stops one StaXX server's error reports
// being filed (manager or owner, in a browser). A blocked server is
// still answered `{ ok: true }`, so it learns nothing to work around. Cards
// already filed are left alone.
export default defineEventHandler(async (event) => {
  const { session } = await requireConnectionModerator(event)
  const id = getRouterParam(event, 'id')!
  const db = useDB()
  const [row] = await db.update(staxxErrorServer)
    .set({ blocked: true })
    .where(eq(staxxErrorServer.id, id))
    .returning({ id: staxxErrorServer.id })
  if (!row) throw createError({ statusCode: 404, message: 'Server not found' })
  console.info(`[staxx] block server=${id} by=${session.user.id}`)
  setResponseStatus(event, 204)
  return null
})
