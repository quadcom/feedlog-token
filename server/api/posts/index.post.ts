import { and, eq } from 'drizzle-orm'
import { board } from '#layers/feedlog/server/db/schemas'
import { createPostSchema } from '#layers/feedlog/shared/schemas/post'
import { isActorAdmin } from '#layers/feedlog/shared/utils/notifications'

// POST /api/posts — Create a post (any authenticated user: end-user or staff).
export default defineEventHandler(async (event) => {
  const { session, orgId } = await requireAuthInOrg(event)
  await assertGuestMay(event, session, 'allowPost')

  const body = await readValidatedBody(event, createPostSchema.parse)

  // A staff-only board does not exist for anyone else, so it cannot be posted to either.
  if (body.boardId && !canSeeStaffBoards(session, orgId)) {
    const [hiddenBoard] = await useDB().select({ id: board.id }).from(board)
      .where(and(eq(board.id, body.boardId), eq(board.visibility, 'staff'))).limit(1)
    if (hiddenBoard) throw createError({ statusCode: 404, message: 'Board not found' })
  }

  const created = await createPostRecord({
    orgId,
    authorId: session.user.id,
    title: body.title,
    content: body.content,
    boardId: body.boardId,
    subscribeAuthor: !isActorAdmin(session, orgId),
  })

  publishDomainEvent(event, createDomainEvent({
    name: 'feedback.created',
    orgId,
    userId: session.user.id,
    data: { feedbackId: created.id, boardId: created.boardId, source: 'portal', messageId: null },
  }))

  const author = await fetchPostAuthor(session.user.id)

  setResponseStatus(event, 201)
  return {
    id: created.id,
    slug: created.slug,
    title: created.title,
    content: created.content,
    status: created.status,
    boardId: created.boardId,
    voteCount: created.voteCount,
    commentCount: created.commentCount,
    mergedCount: 0,
    mergedTo: null,
    hasVoted: false,
    author: author ?? { id: session.user.id, name: null, image: null },
    createdAt: created.createdAt,
    updatedAt: created.updatedAt,
  } satisfies PostDetail
})
