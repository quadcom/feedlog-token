import { pgTable, text, integer, timestamp, uuid, index } from 'drizzle-orm/pg-core'
import { uuidv7 } from 'uuidv7'
import { post } from './index'

// Private files on a card (local/PLAN-private-attachments.md). Never part of any
// card payload: only the endpoints under /api/posts/:postId/attachments read
// this table, and they check author-or-staff on every request.
export const cardAttachment = pgTable('card_attachment', {
  id: text('id').primaryKey().$defaultFn(() => uuidv7()),
  orgId: text('org_id').notNull(),
  // Cascade is what "deleted with the card" rides on: upstream's delete route
  // removes the post and the rows follow, without that route knowing this table
  // exists. The files themselves are removed by the sweep, which deletes any
  // file under the private prefix that no longer has a row.
  postId: uuid('post_id').notNull().references(() => post.id, { onDelete: 'cascade' }),
  uploaderId: text('uploader_id').notNull(),
  filename: text('filename').notNull(),
  contentType: text('content_type').notNull(),
  size: integer('size').notNull(),
  // Blob pathname under ATTACHMENT_PREFIX. Never sent to a client.
  storageKey: text('storage_key').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (t) => [
  index('idx_card_attachment_post').on(t.postId),
  index('idx_card_attachment_expires').on(t.expiresAt),
])
