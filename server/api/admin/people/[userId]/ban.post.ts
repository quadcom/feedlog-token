import { eq } from 'drizzle-orm'
import { z } from 'zod/v4'
import { user } from '#layers/feedlog/server/db/schemas'

const schema = z.object({
  reason: z.string().trim().max(200).optional(),
  // Omitted or null: until unbanned.
  expiresInDays: z.number().int().min(1).max(3650).nullable().optional(),
})

// POST /api/admin/people/:userId/ban — ban the person (manager or owner).
// Body: { reason?, expiresInDays? }.
//
// Sets better-auth's own ban columns rather than calling the admin plugin's ban
// endpoint: that one is gated on the site-wide `admin` user role, which nobody
// here has, not on FeedLog's workspace roles. The plugin still does the part
// that matters: its session-create hook refuses a new session for a banned user
// (and lifts an expired ban itself), so they cannot sign in again. It does not
// check sessions that already exist, so those are all ended here.
//
// The flag is on the account, not the workspace. This fork runs one workspace,
// so that is the same thing; on a multi-workspace deployment it would not be.
export default defineEventHandler(async (event) => {
  const { session, orgId, role } = await requireConnectionModerator(event)
  const userId = getRouterParam(event, 'userId')!
  const body = await readValidatedBody(event, schema.parse)
  const db = useDB()
  await assertMayActOn(db, { userId: session.user.id, orgId, role }, userId)

  const banExpires = body.expiresInDays
    ? new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000)
    : null
  await db.update(user)
    .set({ banned: true, banReason: body.reason || null, banExpires })
    .where(eq(user.id, userId))
  await endAllSessions(db, userId, session.user.id)
  logBurn('ban', session.user.id, userId, banExpires ? `until=${banExpires.toISOString()}` : 'until=unbanned')
  return { ok: true, banExpires: banExpires?.toISOString() ?? null }
})
