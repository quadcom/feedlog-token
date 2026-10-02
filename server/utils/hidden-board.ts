import { sql, type SQL } from 'drizzle-orm'
import { post } from '#layers/feedlog/server/db/schemas'

// Hidden boards (local/PLAN-error-intake.md): a board whose visibility is 'staff', and every
// card, comment, vote and attachment on it, exists only for owners and managers. Everyone else
// — guests, members, contributors, agent tokens at those roles — gets the same answer they
// would for something that was never there: left out of lists, 404 on a direct read.
//
// The check lives here, one place, because the alternative is a filter remembered separately
// in thirty routes. Each route adds `visiblePostCondition(...)` to its where clause, so a
// forgotten route is a visible omission in review rather than a silent leak.

const STAFF_ROLES = new Set(['owner', 'manager'])

type Session = Awaited<ReturnType<typeof getUserSession>>

export function canSeeStaffBoards(session: Session, orgId: string | undefined): boolean {
  return STAFF_ROLES.has(getOrgMemberRole(session, orgId) ?? '')
}

// Condition for queries over `post`: undefined (no restriction) for staff, otherwise "not on a
// staff board". A post with no board stays visible. Written as NOT EXISTS so a deleted board
// can never make its old cards vanish by accident.
export function visiblePostCondition(session: Session, orgId: string | undefined): SQL | undefined {
  if (canSeeStaffBoards(session, orgId)) return undefined
  return notOnStaffBoard(post.boardId)
}

// Same test over any board-id column, for queries that reach posts through another table.
export function notOnStaffBoard(boardIdColumn: SQL | { name: string } | unknown): SQL {
  return sql`NOT EXISTS (SELECT 1 FROM board hb WHERE hb.id = ${boardIdColumn} AND hb.visibility = 'staff')`
}

// Same test as a post id, for tables that only hold a post id (comment, vote, attachment).
export function postVisibleById(postIdColumn: unknown): SQL {
  return sql`NOT EXISTS (SELECT 1 FROM post hp JOIN board hb ON hb.id = hp.board_id WHERE hp.id = ${postIdColumn} AND hb.visibility = 'staff')`
}

// Cards on a staff board are records, not conversations (local/PLAN-explain-card-view.md): the
// write routes for comments, votes and subscriptions call this after their own 404 check, so
// staff are refused too. Reads of such a post are unchanged.
export async function isStaffBoardPost(postId: string): Promise<boolean> {
  const [row] = await useDB().select({ hit: sql<number>`1` }).from(post)
    .where(sql`${post.id} = ${postId} AND NOT (${postVisibleById(post.id)})`).limit(1)
  return !!row
}

export async function assertNotStaffBoard(postId: string): Promise<void> {
  if (await isStaffBoardPost(postId)) {
    throw createError({ statusCode: 403, message: 'This board does not take comments or votes.' })
  }
}
