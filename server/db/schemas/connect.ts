import { pgTable, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { relations, sql } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'
import { organization, user } from './auth'

// One row per app connection: a program (StaXX, say) acting as a real person on
// this board, approved by that person through a sign-in code. See
// docs/connect-an-app.md.
//
// As with agent_token, the credential itself is not here. It is an ordinary
// better-auth session for the person's own user, and this row holds what a
// session cannot: which app and installation it belongs to, the pending code
// while it is being approved, and whether it has been cut off. The session is
// what server/middleware/connect-guard.ts narrows — it finds this row by
// session_id on every bearer request.
//
// The raw token is never stored here. It is minted at the first poll after
// approval, returned to the app once, and the device-code hash is cleared in the
// same step so the code cannot collect a second one.
export const appConnection = pgTable('app_connection', {
  id: text('id').primaryKey().$defaultFn(() => uuidv7()),
  orgId: text('org_id').notNull().references(() => organization.id, { onDelete: 'cascade' }),
  // Null until a person approves the code. Cascade: deleting the person removes
  // their connections, and — through session.user_id — the credentials too.
  userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
  // session.id once connected. No foreign key, for agent_token's reason: better-
  // auth owns that table. Revoking deletes the session row explicitly.
  sessionId: text('session_id'),
  app: text('app').notNull(),
  label: text('label').notNull(),
  // XXXX-XXXX while pending or approved-but-uncollected; null afterwards.
  userCode: text('user_code'),
  // SHA-256 (hex) of the device code the app polls with. A hash, because a
  // database dump must not be enough to collect somebody's token.
  deviceCodeHash: text('device_code_hash'),
  status: text('status').notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  codeExpiresAt: timestamp('code_expires_at', { withTimezone: true }).notNull(),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  // Mirrors session.expires_at once connected, so lists need no join.
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  // Touched at most hourly by the guard: accurate enough for "is this still in
  // use?", and it keeps a busy app from writing on every request.
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  // Who ended it: the person themself, a manager's user id, or null for the app.
  revokedBy: text('revoked_by'),
}, (t) => [
  index('idx_app_connection_org').on(t.orgId, sql`${t.createdAt} DESC`),
  index('idx_app_connection_user').on(t.userId),
  uniqueIndex('idx_app_connection_session').on(t.sessionId).where(sql`${t.sessionId} IS NOT NULL`),
  uniqueIndex('idx_app_connection_user_code').on(t.userCode).where(sql`${t.userCode} IS NOT NULL`),
  uniqueIndex('idx_app_connection_device_code').on(t.deviceCodeHash).where(sql`${t.deviceCodeHash} IS NOT NULL`),
])

export const appConnectionRelations = relations(appConnection, ({ one }) => ({
  organization: one(organization, { fields: [appConnection.orgId], references: [organization.id] }),
  user: one(user, { fields: [appConnection.userId], references: [user.id] }),
}))
