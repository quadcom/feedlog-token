import { asc, eq } from 'drizzle-orm'
import { cardAttachment } from '#layers/feedlog/server/db/schemas'

// GET /api/posts/:postId/attachments — the card's private files, for its author
// and managers/owners. Anyone else gets 404, as if the route did not exist.
export default defineEventHandler(async (event) => {
  const postId = getRouterParam(event, 'postId')!
  await requireAttachmentAccess(event, postId)
  const rows = await useDB().select().from(cardAttachment)
    .where(eq(cardAttachment.postId, postId))
    .orderBy(asc(cardAttachment.createdAt))
  // An expired file the sweep has not reached yet is already gone as far as
  // anyone is concerned.
  const now = Date.now()
  return { data: rows.filter(r => r.expiresAt.getTime() > now).map(attachmentToView) }
})
