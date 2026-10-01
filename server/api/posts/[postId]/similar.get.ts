import { and, eq } from 'drizzle-orm'
import { post } from '#layers/feedlog/server/db/schemas'

// GET /api/posts/:postId/similar — Similar posts by stored embedding (for post detail + merge dialog default)
export default defineEventHandler(async (event) => {
  const session = await getUserSession(event)
  const orgId = event.context.orgId!
  const postId = getRouterParam(event, 'postId')!
  const query = getQuery(event)
  const limit = Math.min(Math.max(Number(query.limit) || 3, 1), 10)

  const userId = session?.user?.id
  const includeStaffBoards = canSeeStaffBoards(session, orgId)
  // The card being compared must itself be visible; otherwise its neighbours would reveal it.
  const [target] = await useDB().select({ id: post.id }).from(post)
    .where(and(eq(post.id, postId), eq(post.orgId, orgId), visiblePostCondition(session, orgId))).limit(1)
  if (!target) throw createError({ statusCode: 404, message: 'Post not found' })
  const data = await searchSimilarByPostId(postId, { orgId, limit, userId, includeStaffBoards })
  return { data }
})
