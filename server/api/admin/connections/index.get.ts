import { and, desc, eq, inArray, or } from 'drizzle-orm'
import { appConnection, member, user } from '#layers/feedlog/server/db/schemas'

// GET /api/admin/connections — every app connection in the workspace, with its
// person, for the Members page (manager or owner). Also the people currently
// banned, so Unban stays reachable once their connections have all ended.
//
// Board users are mostly not workspace members, which is why this is its own
// list rather than extra buttons on the member rows: someone spamming through
// StaXX will not be on the members list at all.
export default defineEventHandler(async (event) => {
  const { orgId } = await requireConnectionModerator(event)
  const db = useDB()

  const rows = await db
    .select({
      connection: appConnection,
      person: {
        id: user.id,
        name: user.name,
        email: user.email,
        image: user.image,
        banned: user.banned,
      },
      role: member.role,
    })
    .from(appConnection)
    .innerJoin(user, eq(user.id, appConnection.userId))
    .leftJoin(member, and(eq(member.organizationId, orgId), eq(member.userId, appConnection.userId)))
    .where(and(eq(appConnection.orgId, orgId), inArray(appConnection.status, ['connected', 'revoked'])))
    .orderBy(desc(appConnection.createdAt))
    .limit(200)

  // Banned people this workspace knows: members, or anyone who has connected.
  const banned = await db
    .selectDistinct({
      id: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
      banReason: user.banReason,
      banExpires: user.banExpires,
    })
    .from(user)
    .leftJoin(member, and(eq(member.userId, user.id), eq(member.organizationId, orgId)))
    .leftJoin(appConnection, and(eq(appConnection.userId, user.id), eq(appConnection.orgId, orgId)))
    .where(and(eq(user.banned, true), or(eq(member.organizationId, orgId), eq(appConnection.orgId, orgId))))
    .limit(200)

  return {
    data: rows.map(r => ({
      ...connectionToView(r.connection),
      person: { ...r.person, banned: !!r.person.banned, role: r.role ?? null },
    })),
    banned: banned.map(b => ({ ...b, banExpires: b.banExpires?.toISOString() ?? null })),
  }
})
