import { and, eq, sql } from 'drizzle-orm'
import { post, staxxErrorShape } from '#layers/feedlog/server/db/schemas'
import { updateShapeSchema } from '#layers/feedlog/shared/schemas/post'

// PATCH /api/admin/staxx/shapes/:postId — record the explanation written for a staff-board
// "Explain:" card, and when it was written and released (local/PLAN-explain-card-view.md).
// Moderate permission, so the manager agent token can call it. Fields left out are kept.
export default defineEventHandler(async (event) => {
  const postId = getRouterParam(event, 'postId')!
  const body = await readValidatedBody(event, updateShapeSchema.parse)
  const { orgId } = await requireOrgPermission(event, { feedlog: ['moderate'] })

  const db = useDB()
  const [p] = await db.select({ id: post.id }).from(post)
    .where(and(eq(post.id, postId), eq(post.orgId, orgId))).limit(1)
  if (!p) throw createError({ statusCode: 404, message: 'Post not found' })
  if (!await isStaffBoardPost(postId)) {
    throw createError({ statusCode: 400, message: 'This post is not on a staff board' })
  }

  const when = (v: true | string | undefined) => v === undefined ? undefined : v === true ? sql`now()` : new Date(v)
  const [updated] = await db.update(staxxErrorShape)
    .set({
      explanationId: body.explanationId,
      explanationTitle: body.explanationTitle,
      writtenAt: when(body.writtenAt),
      releasedAt: when(body.releasedAt),
      releaseRef: body.releaseRef,
    })
    .where(eq(staxxErrorShape.postId, postId))
    .returning()
  if (!updated) throw createError({ statusCode: 404, message: 'No error record for this post' })
  return updated
})
