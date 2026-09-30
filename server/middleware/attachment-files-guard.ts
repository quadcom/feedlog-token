import { ATTACHMENT_PREFIX } from '#layers/feedlog/shared/constants/attachment'

// Keeps private card attachments off the public file route.
//
// GET /api/files/** serves any stored path to anyone, with no check — that is
// how pictures on public cards work, and it is upstream's route. Private
// attachments live in the same blob store under ATTACHMENT_PREFIX, so without
// this guard anyone who learned or guessed a storage key could fetch the file.
// The only way to read one is /api/posts/:postId/attachments/:id, which checks
// author-or-staff on every request.
//
// The check is on a canonical form of the path, and refuses the prefix as any
// segment rather than only the first: percent-encoding (even doubled),
// backslashes, `.`/`..` segments and case are all folded first. The Windows
// filesystem driver matches paths case-insensitively, so /api/files/PRIVATE-…
// would reach the same folder. Canonicalising can only make this refuse more.

const FILES_ROUTE = /^\/api\/files(\/|$)/

function canonical(path: string): string {
  let p = path.split('?')[0] ?? path
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(p)
      if (next === p) break
      p = next
    }
    catch { break }
  }
  const out: string[] = []
  for (const seg of p.replace(/\\/g, '/').toLowerCase().split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return `/${out.join('/')}`
}

export default defineEventHandler((event) => {
  const raw = event.path
  // Cheap test first: every request passes through here.
  if (!/files/i.test(raw) && !/[%\\]/.test(raw)) return
  const path = canonical(raw)
  if (!FILES_ROUTE.test(path)) return
  if (path.split('/').includes(ATTACHMENT_PREFIX)) {
    throw createError({ statusCode: 404, message: 'Not found' })
  }
})
