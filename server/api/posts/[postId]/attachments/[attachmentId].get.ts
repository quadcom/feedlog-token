import { and, eq } from 'drizzle-orm'
import { cardAttachment } from '#layers/feedlog/server/db/schemas'

// GET /api/posts/:postId/attachments/:attachmentId — download one private file.
//
// Always a download, never a page: these are other people's logs, and a log
// can contain anything, including markup. Content-Disposition makes the browser
// save it, nosniff stops it guessing a type, and a sandbox CSP means that even
// if something did render it, no script would run.
export default defineEventHandler(async (event) => {
  const postId = getRouterParam(event, 'postId')!
  const attachmentId = getRouterParam(event, 'attachmentId')!
  await requireAttachmentAccess(event, postId)

  const [row] = await useDB().select().from(cardAttachment)
    .where(and(eq(cardAttachment.id, attachmentId), eq(cardAttachment.postId, postId)))
    .limit(1)
  if (!row || row.expiresAt.getTime() <= Date.now()) {
    throw createError({ statusCode: 404, message: 'Not found' })
  }
  const file = await blobStorage.get(row.storageKey)
  if (!file) throw createError({ statusCode: 404, message: 'Not found' })

  setResponseHeaders(event, {
    'Content-Type': row.contentType,
    'Content-Disposition': dispositionFor(row.filename),
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': 'sandbox',
    'Cache-Control': 'private, no-store',
  })
  return new Uint8Array(await file.arrayBuffer())
})
