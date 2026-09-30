import { eq } from 'drizzle-orm'
import { cardAttachment } from '#layers/feedlog/server/db/schemas'
import {
  ATTACHMENT_KEEP_DAYS,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENTS_PER_CARD,
  ATTACHMENTS_PER_HOUR,
} from '#layers/feedlog/shared/constants/attachment'

// POST /api/posts/:postId/attachments — attach a private file to a card.
// multipart/form-data, field `file`. The card's author or a manager/owner only.
// Contract: docs/connect-an-app.md; plan: local/PLAN-private-attachments.md.
export default defineEventHandler(async (event) => {
  const postId = getRouterParam(event, 'postId')!
  const { session, orgId, isStaff } = await requireAttachmentAccess(event, postId)

  // Refuse an oversized body before reading it: the multipart reader buffers the
  // whole request. The margin covers the multipart framing around the file.
  const declared = Number(getHeader(event, 'content-length') || 0)
  if (declared > ATTACHMENT_MAX_BYTES + 64 * 1024) throw tooLarge()

  const db = useDB()
  const count = await db.$count(cardAttachment, eq(cardAttachment.postId, postId))
  if (count >= ATTACHMENTS_PER_CARD) {
    throw createError({
      statusCode: 409,
      message: `A card can have at most ${ATTACHMENTS_PER_CARD} attachments.`,
      data: { code: 'ATTACHMENT_LIMIT_REACHED' },
    })
  }

  if (!isStaff && !await checkRateLimit(`attachments:${session.user.id}`, { limit: ATTACHMENTS_PER_HOUR, windowSeconds: 3600 })) {
    throw createError({
      statusCode: 429,
      message: `You have attached ${ATTACHMENTS_PER_HOUR} files this hour. Try again later.`,
      data: { code: 'ATTACHMENT_RATE_LIMITED' },
    })
  }

  const parts = await readMultipartFormData(event)
  const part = parts?.find(p => p.name === 'file' && p.filename)
  if (!part) throw createError({ statusCode: 400, message: 'No file provided' })
  if (part.data.length > ATTACHMENT_MAX_BYTES) throw tooLarge()
  if (part.data.length === 0) throw createError({ statusCode: 400, message: 'The file is empty' })

  const filename = safeFilename(part.filename)
  const contentType = acceptedType(filename, part.type)
  if (!contentType || !looksLike(contentType, part.data)) {
    throw createError({
      statusCode: 415,
      message: 'Attach a .txt, .log, .json or .zip file.',
      data: { code: 'ATTACHMENT_TYPE_NOT_ALLOWED' },
    })
  }

  const storageKey = attachmentStorageKey(orgId, postId, filename)
  await blobStorage.put(storageKey, part.data, { contentType, access: 'private' })

  const [row] = await db.insert(cardAttachment).values({
    orgId,
    postId,
    uploaderId: session.user.id,
    filename,
    contentType,
    size: part.data.length,
    storageKey,
    expiresAt: new Date(Date.now() + ATTACHMENT_KEEP_DAYS * 24 * 60 * 60 * 1000),
  }).returning()

  setResponseStatus(event, 201)
  return attachmentToView(row!)
})

function tooLarge() {
  return createError({
    statusCode: 413,
    message: `Attachments can be at most ${ATTACHMENT_MAX_BYTES / (1024 * 1024)} MB.`,
    data: { code: 'ATTACHMENT_TOO_LARGE' },
  })
}
