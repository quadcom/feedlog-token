import { and, eq, sql, asc, inArray } from 'drizzle-orm'
import { board, post } from '#layers/feedlog/server/db/schemas'
import { parseStatusParam } from '#layers/feedlog/shared/types/post'

// GET /api/boards — List boards (sorted by position, with post_count and total)
export default defineEventHandler(async (event): Promise<{ data: BoardItem[]; totalPostCount: number }> => {
  const db = useDB()
  const orgId = event.context.orgId!
  const session = await getUserSession(event)
  // Staff boards are named to staff only; their cards are left out of the counts below too.
  const staffView = canSeeStaffBoards(session, orgId)

  // Optional `status` (one name or a comma-separated list) narrows the counts the
  // same way it narrows GET /api/posts — a badge reading 8 above a list of 3 reads
  // as a bug. Omitted, the counts stay what they always were.
  const statuses = parseStatusParam(getQuery(event).status)
  const statusFilter = statuses.length === 1
    ? eq(post.status, statuses[0]!)
    : statuses.length > 1 ? inArray(post.status, statuses) : undefined

  const [boards, totalResult] = await Promise.all([
    db
      .select({
        id: board.id,
        name: board.name,
        description: board.description,
        position: board.position,
        visibility: board.visibility,
        postCount: sql<number>`cast(count(${post.id}) as int)`,
        createdAt: board.createdAt,
      })
      .from(board)
      .leftJoin(post, and(eq(post.boardId, board.id), eq(post.orgId, orgId), statusFilter))
      .where(and(eq(board.orgId, orgId), staffView ? undefined : eq(board.visibility, 'public')))
      .groupBy(board.id)
      .orderBy(asc(board.position)),
    db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(post)
      .where(and(eq(post.orgId, orgId), statusFilter, visiblePostCondition(session, orgId))),
  ])

  return { data: boards, totalPostCount: totalResult[0]?.count ?? 0 }
})
