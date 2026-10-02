import { z } from 'zod/v4'

export const createPostSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200, 'Title must be 200 characters or less'),
  content: z.string().trim().min(1, 'Content is required').max(10000, 'Content must be 10000 characters or less'),
  boardId: z.uuid().nullable().optional(),
})

// Fields of a staff-board "Explain:" card (PATCH /api/admin/staxx/shapes/:postId).
// A date is `true` for "now" or an ISO timestamp.
const whenSchema = z.union([z.literal(true), z.iso.datetime({ offset: true })])
export const updateShapeSchema = z.strictObject({
  explanationId: z.string().trim().min(1).max(64),
  explanationTitle: z.string().trim().min(1).max(200),
  writtenAt: whenSchema.optional(),
  releasedAt: whenSchema.optional(),
  releaseRef: z.string().trim().regex(/^[0-9a-f]{7,64}$/i, 'releaseRef must be a commit id').optional(),
})

// Author can edit title/content, admin can edit any field
export const updatePostSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200, 'Title must be 200 characters or less').optional(),
  content: z.string().trim().min(1, 'Content is required').max(10000, 'Content must be 10000 characters or less').optional(),
  status: z.enum(['open', 'planned', 'in_progress', 'done']).optional(),
  boardId: z.uuid().nullable().optional(),
})
