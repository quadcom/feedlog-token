#!/usr/bin/env tsx
// End-to-end probe for the record view of staff-board "Explain:" cards
// (local/PLAN-explain-card-view.md).
//
// The claims being tested: every accepted error report raises the shape's report count; the
// post detail carries an `explain` object for staff on a staff board and never otherwise; a
// staff-board card takes no comments, votes or subscriptions (403 for staff, 404 for everyone
// else) and its comment list is empty; PATCH /api/admin/staxx/shapes/:postId sets and returns
// the explanation fields, keeps fields left out, and refuses bad bodies, other people and posts
// on public boards; an ordinary card on a public board is unchanged.
//
// Needs the board "Error explanations" (visibility staff) and STAXX_REPORTER_USER_ID on the
// server under test, a manager account and a signed-in person with no workspace role, both
// signing in with email and password. Run it against a scratch server, on a fresh app start
// (the intake's day limits are in memory), never production.
//
// Usage:
//   FEEDLOG_URL=http://localhost:3000 PROBE_MANAGER=mgr@example.com:pass \
//   PROBE_USER=alice@example.com:pass pnpm dlx tsx scripts/explain-card-probe.ts

const BASE = (process.env.FEEDLOG_URL || 'http://localhost:3000').replace(/\/$/, '')

let passed = 0
let failed = 0

async function step(name: string, run: () => Promise<{ ok: boolean; detail?: string }>) {
  try {
    const { ok, detail } = await run()
    if (ok) passed++
    else failed++
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  }
  catch (e) {
    failed++
    console.log(`  FAIL  ${name} — threw: ${(e as Error).message}`)
  }
}

interface Res { status: number; body: any }
interface Caller { cookie?: string }

async function req(path: string, init: RequestInit & { as?: Caller; json?: unknown; ip?: string } = {}): Promise<Res> {
  const { as, json, ip, ...rest } = init
  const headers: Record<string, string> = { Origin: BASE }
  if (json !== undefined) headers['Content-Type'] = 'application/json'
  if (as?.cookie) headers.Cookie = as.cookie
  if (ip) headers['X-Real-IP'] = ip
  const res = await fetch(`${BASE}${path}`, { ...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body })
  const text = await res.text()
  let body: any = text
  try { body = JSON.parse(text) }
  catch { /* keep text */ }
  return { status: res.status, body }
}

async function signIn(name: string): Promise<Caller> {
  const raw = process.env[name] || ''
  const i = raw.indexOf(':')
  if (i < 0) {
    console.error(`${name}=email:password is required`)
    process.exit(1)
  }
  const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ email: raw.slice(0, i), password: raw.slice(i + 1) }),
  })
  if (res.status !== 200) throw new Error(`sign-in for ${name} answered ${res.status}`)
  return { cookie: res.headers.getSetCookie().map(s => s.split(';')[0]).join('; ') }
}

const stamp = Date.now()
const shape = `validating compose.yml: services.web additional properties 'explain${stamp}x' not allowed`

async function main() {
  console.log(`Probing ${BASE}\n`)
  const mgr = await signIn('PROBE_MANAGER')
  const user = await signIn('PROBE_USER')

  const boards = (await req('/api/boards', { as: mgr })).body?.data ?? []
  const errBoard = boards.find((b: { name: string }) => b.name === 'Error explanations')
  if (!errBoard) {
    console.error('The manager cannot see a board called "Error explanations"; create it as a staff board first')
    process.exit(1)
  }
  const openBoard = (await req('/api/admin/boards', { method: 'POST', as: mgr, json: { name: `Open explain${stamp}` } })).body
  const publicCard = (await req('/api/posts', { method: 'POST', as: mgr, json: { title: `Plain card ${stamp}`, content: 'An ordinary card.', boardId: openBoard.id } })).body

  const report = (ip: string, serverId?: string) =>
    req('/api/apps/staxx/error-report', { method: 'POST', ip, json: { shape, staxxVersion: '00.05.00', composeVersion: '2.40.3', ...(serverId ? { serverId } : {}) } })

  console.log('Intake')
  const first = await report('10.8.0.1')
  const serverId = first.body?.serverId
  const card = ((await req(`/api/posts?boardId=${errBoard.id}&pageSize=100`, { as: mgr })).body?.data ?? [])
    .find((c: { title: string }) => c.title === `Explain: ${shape}`)
  const detail = async (who: Caller = mgr) => req(`/api/posts/${card?.slug}`, { as: who })
  await step('a new shape files one card and counts one report', async () => {
    const d = await detail()
    return { ok: !!card && d.body?.explain?.reportCount === 1 && d.body?.explain?.serversSeen === 1, detail: `reports ${d.body?.explain?.reportCount}` }
  })
  await step('a repeat from the same server raises reports, not servers', async () => {
    await report('10.8.0.1', serverId)
    const e = (await detail()).body?.explain
    return { ok: e?.reportCount === 2 && e?.serversSeen === 1, detail: `reports ${e?.reportCount}, servers ${e?.serversSeen}` }
  })
  await step('a report from a second server raises both', async () => {
    await report('10.8.0.2')
    const e = (await detail()).body?.explain
    return { ok: e?.reportCount === 3 && e?.serversSeen === 2, detail: `reports ${e?.reportCount}, servers ${e?.serversSeen}` }
  })

  console.log('\nThe record view')
  await step('staff detail carries explain, with the explanation fields still empty', async () => {
    const e = (await detail()).body?.explain
    return { ok: e?.shape === shape && e?.explanationId === null && e?.writtenAt === null && e?.releasedAt === null && !!e?.firstSeenAt && !!e?.lastSeenAt }
  })
  await step('a person with no workspace role gets 404 for the card', async () => ({ ok: (await detail(user)).status === 404 }))
  await step('an ordinary card on a public board has no explain', async () => {
    const d = await req(`/api/posts/${publicCard.slug}`, { as: mgr })
    return { ok: d.status === 200 && d.body?.explain === undefined }
  })
  await step('the comment list of the staff card is empty', async () => {
    const r = await req(`/api/posts/${card?.id}/comments`, { as: mgr })
    return { ok: r.status === 200 && (r.body?.data ?? []).length === 0 }
  })

  console.log('\nComments, votes and following')
  const attempts: Array<[string, string, unknown?]> = [
    ['comment', `/api/posts/${card?.id}/comments`, { content: 'hello' }],
    ['vote', `/api/posts/${card?.id}/vote`],
    ['subscribe', `/api/posts/${card?.id}/subscription`],
  ]
  for (const [what, path, json] of attempts) {
    await step(`${what} on the staff card: 403 for a manager`, async () => {
      const r = await req(path, { method: 'POST', as: mgr, json })
      return { ok: r.status === 403 && /does not take comments or votes/.test(r.body?.message ?? ''), detail: `${r.status} ${r.body?.message ?? ''}` }
    })
    await step(`${what} on the staff card: 404 for a person with no role`, async () => {
      const r = await req(path, { method: 'POST', as: user, json })
      return { ok: r.status === 404, detail: String(r.status) }
    })
  }
  await step('removing a vote on the staff card: 403 for a manager', async () => {
    const r = await req(`/api/posts/${card?.id}/vote`, { method: 'DELETE', as: mgr })
    return { ok: r.status === 403, detail: String(r.status) }
  })
  await step('an ordinary card still takes a comment, a vote and a like', async () => {
    const c = await req(`/api/posts/${publicCard.id}/comments`, { method: 'POST', as: mgr, json: { content: 'still works' } })
    const v = await req(`/api/posts/${publicCard.id}/vote`, { method: 'POST', as: mgr })
    const l = await req(`/api/comments/${c.body?.id}/like`, { method: 'POST', as: mgr })
    return { ok: c.status === 201 && v.status === 200 && l.status === 200, detail: `${c.status}/${v.status}/${l.status}` }
  })

  console.log('\nThe shapes route')
  const patch = (id: string | undefined, json: unknown, as: Caller = mgr) =>
    req(`/api/admin/staxx/shapes/${id}`, { method: 'PATCH', as, json })
  await step('sets the explanation and the written date, returns them', async () => {
    const r = await patch(card?.id, { explanationId: 'not-a-list', explanationTitle: 'A setting that needs a list', writtenAt: true })
    return { ok: r.status === 200 && r.body?.explanationId === 'not-a-list' && r.body?.explanationTitle === 'A setting that needs a list' && !!r.body?.writtenAt && r.body?.releasedAt === null, detail: String(r.status) }
  })
  await step('the detail shows them, and the report count is untouched', async () => {
    const e = (await detail()).body?.explain
    return { ok: e?.explanationId === 'not-a-list' && !!e?.writtenAt && e?.reportCount === 3 }
  })
  await step('a later patch sets the release and keeps the written date', async () => {
    const before = (await detail()).body?.explain?.writtenAt
    const r = await patch(card?.id, { explanationId: 'not-a-list', explanationTitle: 'A setting that needs a list', releasedAt: '2026-10-02T12:00:00Z', releaseRef: '5b1b756' })
    const e = (await detail()).body?.explain
    return { ok: r.status === 200 && e?.releaseRef === '5b1b756' && new Date(e?.releasedAt).toISOString() === '2026-10-02T12:00:00.000Z' && e?.writtenAt === before, detail: String(r.status) }
  })
  await step('the card list carries the released date; the card can move to done', async () => {
    const s = await req(`/api/admin/posts/${card?.id}`, { method: 'PATCH', as: mgr, json: { status: 'done' } })
    const row = ((await req(`/api/posts?boardId=${errBoard.id}&pageSize=100`, { as: mgr })).body?.data ?? []).find((c: { id: string }) => c.id === card?.id)
    return { ok: s.status === 200 && row?.status === 'done' && !!row?.releasedAt, detail: `${s.status}, ${row?.releasedAt}` }
  })
  await step('a post on a public board is refused', async () => {
    const r = await patch(publicCard.id, { explanationId: 'x', explanationTitle: 'x' })
    return { ok: r.status === 400, detail: String(r.status) }
  })
  await step('an unknown post is 404', async () => {
    const r = await patch('00000000-0000-4000-8000-000000000000', { explanationId: 'x', explanationTitle: 'x' })
    return { ok: r.status === 404, detail: String(r.status) }
  })
  await step('a person with no role is refused', async () => {
    const r = await patch(card?.id, { explanationId: 'x', explanationTitle: 'x' }, user)
    return { ok: r.status === 401 || r.status === 403, detail: String(r.status) }
  })
  await step('a signed-out caller is refused', async () => {
    const r = await patch(card?.id, { explanationId: 'x', explanationTitle: 'x' }, {})
    return { ok: r.status === 401 || r.status === 403, detail: String(r.status) }
  })
  const bad: Array<[string, unknown]> = [
    ['an empty explanation id', { explanationId: '', explanationTitle: 'x' }],
    ['a missing title', { explanationId: 'x' }],
    ['an unknown field', { explanationId: 'x', explanationTitle: 'x', extra: 1 }],
    ['a release ref that is not a commit id', { explanationId: 'x', explanationTitle: 'x', releaseRef: 'not a commit' }],
    ['a date that is not a date', { explanationId: 'x', explanationTitle: 'x', releasedAt: 'yesterday' }],
  ]
  for (const [what, json] of bad) {
    await step(`${what} is 400 and changes nothing`, async () => {
      const r = await patch(card?.id, json)
      const e = (await detail()).body?.explain
      return { ok: r.status === 400 && e?.explanationId === 'not-a-list', detail: String(r.status) }
    })
  }

  // The plain card and its board are this run's own.
  await req(`/api/admin/posts/${publicCard.id}`, { method: 'DELETE', as: mgr })
  await req(`/api/admin/boards/${openBoard.id}`, { method: 'DELETE', as: mgr })

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
