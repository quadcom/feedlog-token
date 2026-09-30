// Private card attachments: diagnostic files an app (StaXX) attaches to a card
// it filed, readable only by the card's author and the workspace's managers and
// owners. Contract in docs/connect-an-app.md; plan in local/PLAN-private-attachments.md.

// A log tail or a sanitised compose file is kilobytes; a zip of several is well
// under this. Big enough to be useful, small enough that storage stays boring.
export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024
export const ATTACHMENTS_PER_CARD = 5
// Per person per hour, managers and owners exempt — the same shape as the card cap.
export const ATTACHMENTS_PER_HOUR = 20
// Diagnostic files go stale, and what is not kept cannot leak (Adrian, 2026-09-30).
export const ATTACHMENT_KEEP_DAYS = 90

// Declared type and file extension must agree. Nothing here is ever rendered —
// every download is forced to save — but a narrow list keeps the store to what
// it is for.
export const ATTACHMENT_TYPES: Record<string, readonly string[]> = {
  'text/plain': ['txt', 'log'],
  'application/json': ['json'],
  'application/zip': ['zip'],
}

// Where the files live in blob storage. Deliberately outside the public upload
// prefix, and refused on the public file route by
// server/middleware/attachment-files-guard.ts.
export const ATTACHMENT_PREFIX = 'private-attachments'
