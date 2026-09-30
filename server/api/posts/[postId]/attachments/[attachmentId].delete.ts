import { and, eq } from 'drizzle-orm'
import { cardAttachment } from '#layers/feedlog/server/db/schemas'

// DELETE /api/posts/:postId/attachments/:attachmentId — remove a private file
// (the card's author or a manager/owner). A connected app is refused this by
// connect-guard, so a leaked token cannot erase what it sent; an agent token
// needs its delete capability, like any other delete (agent-delete-guard).
export default defineEventHandler(async (event) => {
  const postId = getRouterParam(event, 'postId')!
  const attachmentId = getRouterParam(event, 'attachmentId')!
  await requireAttachmentAccess(event, postId)

  const [row] = await useDB().delete(cardAttachment)
    .where(and(eq(cardAttachment.id, attachmentId), eq(cardAttachment.postId, postId)))
    .returning({ key: cardAttachment.storageKey })
  if (!row) throw createError({ statusCode: 404, message: 'Not found' })
  await blobStorage.del(row.key)
  setResponseStatus(event, 204)
  return null
})
