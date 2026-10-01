import { desc, sql } from 'drizzle-orm'
import { staxxErrorServer } from '#layers/feedlog/server/db/schemas'

// GET /api/admin/staxx/servers?page=1&pageSize=50 — the StaXX servers that have
// sent error reports, newest first (manager or owner, in a browser). The list is
// what blocking works from: the id here is what `/block` takes.
//
// `lastAddress` is the source address of the server's most recent report, kept so
// a manager can tell one noisy machine from another. It is not shown to anyone else.
export default defineEventHandler(async (event) => {
  await requireConnectionModerator(event)
  const q = getQuery(event)
  const pageSize = Math.min(Math.max(Number(q.pageSize) || 50, 1), 200)
  const page = Math.max(Number(q.page) || 1, 1)
  const db = useDB()

  const rows = await db.select().from(staxxErrorServer)
    .orderBy(desc(staxxErrorServer.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize)
  const [counted] = await db.select({ total: sql<number>`count(*)::int` }).from(staxxErrorServer)
  const total = counted?.total ?? 0

  return {
    data: rows.map(r => ({
      id: r.id,
      createdAt: r.createdAt?.toISOString() ?? null,
      lastSeenAt: r.lastSeenAt?.toISOString() ?? null,
      lastAddress: r.lastAddress,
      reportCount: r.reportCount,
      blocked: r.blocked,
    })),
    page,
    pageSize,
    total,
  }
})
