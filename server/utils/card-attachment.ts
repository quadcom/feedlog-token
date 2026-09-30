import type { H3Event } from 'h3'
import { and, eq, inArray, lt } from 'drizzle-orm'
import { cardAttachment, post } from '#layers/feedlog/server/db/schemas'
import { ATTACHMENT_PREFIX, ATTACHMENT_TYPES } from '#layers/feedlog/shared/constants/attachment'

// Private card attachments (local/PLAN-private-attachments.md). The card is
// public; these files are for the people fixing the bug — the card's author and
// the workspace's managers and owners — and nobody else may learn they exist.

type DB = ReturnType<typeof useDB>

export interface AttachmentView {
  id: string
  filename: string
  contentType: string
  size: number
  createdAt: string
  expiresAt: string
}

export function attachmentToView(row: typeof cardAttachment.$inferSelect): AttachmentView {
  return {
    id: row.id,
    filename: row.filename,
    contentType: row.contentType,
    size: row.size,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  }
}

const STAFF_ROLES = new Set(['owner', 'manager'])

// Author or staff, or a 404 — never a 403, which would tell an outsider that the
// card has something private on it. Looks the card up by id within this org.
export async function requireAttachmentAccess(event: H3Event, postId: string) {
  const notFound = () => createError({ statusCode: 404, message: 'Not found' })
  const session = await getUserSession(event)
  const orgId = event.context.orgId
  if (!session || !orgId) throw notFound()
  if ((session.user as { isAnonymous?: boolean | null }).isAnonymous) throw notFound()

  const [card] = await useDB().select({ id: post.id, authorId: post.authorId }).from(post)
    .where(and(eq(post.id, postId), eq(post.orgId, orgId))).limit(1)
  if (!card) throw notFound()

  const isStaff = STAFF_ROLES.has(getOrgMemberRole(session, orgId) ?? '')
  if (!isStaff && card.authorId !== session.user.id) throw notFound()
  return { session, orgId, card, isStaff }
}

// The declared type must be on the list and agree with the file's extension.
// Returns the canonical type, or null.
export function acceptedType(filename: string, declared: string | undefined): string | null {
  const type = (declared ?? '').split(';')[0]!.trim().toLowerCase()
  const ext = filename.toLowerCase().split('.').pop() ?? ''
  const exts = ATTACHMENT_TYPES[type]
  return exts?.includes(ext) ? type : null
}

// A zip really is one. The download is forced to save either way; this just
// keeps a mislabelled file from sitting in the store under a false name.
export function looksLike(type: string, data: Uint8Array): boolean {
  if (type === 'application/zip') {
    return data.length >= 4 && data[0] === 0x50 && data[1] === 0x4B && (data[2] === 0x03 || data[2] === 0x05)
  }
  return true
}

// Keep a name a person would recognise, minus anything that could break a
// header or a path: directories, control characters, quotes.
export function safeFilename(name: string | undefined): string {
  const base = (name ?? 'attachment').split(/[\\/]/).pop() ?? 'attachment'
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f"]/g, '').trim().slice(0, 120)
  return clean || 'attachment'
}

export function attachmentStorageKey(orgId: string, postId: string, filename: string): string {
  const random = Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString('base64url')
  const ext = filename.toLowerCase().split('.').pop()
  return `${ATTACHMENT_PREFIX}/${orgId}/${postId}/${random}${ext ? `.${ext}` : ''}`
}

// Content-Disposition for a name that may hold anything a person typed: an
// ASCII fallback, and the real name encoded (RFC 6266 / 5987).
export function dispositionFor(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/[\\"]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

// Expired rows and their files; then files with no row, which is how a deleted
// card's files go — the cascade removes the rows, the files stay until here.
// A file younger than an hour is left alone: an upload writes the file a moment
// before it writes the row.
export async function sweepAttachments(db: DB): Promise<{ expired: number; orphans: number }> {
  const expired = await db.delete(cardAttachment)
    .where(lt(cardAttachment.expiresAt, new Date()))
    .returning({ key: cardAttachment.storageKey })
  if (expired.length) await blobStorage.del(expired.map(r => r.key))

  let orphans = 0
  const hourAgo = Date.now() - 60 * 60 * 1000
  let cursor: string | undefined
  do {
    const page = await blobStorage.list({ prefix: `${ATTACHMENT_PREFIX}/`, limit: 500, cursor })
    const old = page.blobs.filter(b => new Date(b.uploadedAt).getTime() < hourAgo).map(b => b.pathname)
    if (old.length) {
      const known = await db.select({ key: cardAttachment.storageKey }).from(cardAttachment)
        .where(inArray(cardAttachment.storageKey, old))
      const keep = new Set(known.map(k => k.key))
      const gone = old.filter(k => !keep.has(k))
      if (gone.length) {
        await blobStorage.del(gone)
        orphans += gone.length
      }
    }
    cursor = page.hasMore ? page.cursor : undefined
  } while (cursor)

  return { expired: expired.length, orphans }
}
