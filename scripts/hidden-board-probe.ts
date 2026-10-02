#!/usr/bin/env tsx
// End-to-end probe for hidden boards (local/PLAN-error-intake.md, "Hidden boards").
//
// The claim being tested: a board whose visibility is "staff", and every card, comment and
// vote on it, exists only for owners and managers. A guest (no session), a signed-in person
// with no workspace role, and a contributor see nothing of it — not in the board list, the
// card list, search, the similar-cards checks, the roadmap or the counts, and a direct read of
// a card or its comments answers 404 (never 403, which would confirm the card exists). A
// manager sees all of it. Only real requests over the wire can show that.
//
// Needs three accounts that sign in with email and password: a signed-in person with no
// workspace role, a contributor, and a manager.
//
// Usage:
//   FEEDLOG_URL=http://localhost:3000 \
//   PROBE_USER=alice@example.com:pass PROBE_CONTRIBUTOR=carol@example.com:pass \
//   PROBE_MANAGER=mgr@example.com:pass [PROBE_DATABASE_URL=postgres://...] \
//   pnpm dlx tsx scripts/hidden-board-probe.ts
//
// With PROBE_DATABASE_URL the probe also moves a card that the signed-in person wrote onto the
// staff board, to prove the author loses sight of it too, and moves it back.
//
// It creates two boards and a few cards (and removes them at the end). Run it
// against a scratch database, never production.

const BASE = (process.env.FEEDLOG_URL || 'http://localhost:3000').replace(/\/$/, '')

function creds(name: string): { email: string; password: string } {
  const raw = process.env[name] || ''
  const i = raw.indexOf(':')
  if (i < 0) {
    console.error(`${name}=email:password is required`)
    process.exit(1)
  }
  return { email: raw.slice(0, i), password: raw.slice(i + 1) }
}

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

async function req(path: string, init: RequestInit & { as?: Caller; json?: unknown } = {}): Promise<Res> {
  const { as, json, ...rest } = init
  const headers: Record<string, string> = { Origin: BASE }
  if (json !== undefined) headers['Content-Type'] = 'application/json'
  if (as?.cookie) headers.Cookie = as.cookie
  const res = await fetch(`${BASE}${path}`, { ...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body })
  const text = await res.text()
  let body: any = text
  try { body = JSON.parse(text) }
  catch { /* keep text */ }
  return { status: res.status, body }
}

async function signIn(c: { email: string; password: string }): Promise<Caller> {
  const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify(c),
  })
  if (res.status !== 200) throw new Error(`sign-in ${c.email} answered ${res.status}`)
  return { cookie: res.headers.getSetCookie().map(s => s.split(';')[0]).join('; ') }
}

const ids = (r: Res): string[] => (r.body?.data ?? []).map((p: { id: string }) => p.id)

async function main() {
  const userC = creds('PROBE_USER')
  const contribC = creds('PROBE_CONTRIBUTOR')
  const mgrC = creds('PROBE_MANAGER')
  console.log(`Probing ${BASE}\n`)

  const mgr = await signIn(mgrC)
  const viewers: [string, Caller][] = [
    ['guest', {}],
    ['signed-in person', await signIn(userC)],
    ['contributor', await signIn(contribC)],
  ]
  const userId = (await req('/api/auth/get-session', { as: viewers[1]![1] })).body?.user?.id

  const tag = `hbprobe${Date.now()}`
  const text = `${tag} zebra-crossing flicker`

  console.log('Setting up')
  const staffBoard = (await req('/api/admin/boards', { method: 'POST', as: mgr, json: { name: `Staff ${tag}`, visibility: 'staff' } })).body
  const openBoard = (await req('/api/admin/boards', { method: 'POST', as: mgr, json: { name: `Open ${tag}` } })).body
  await step('manager creates a staff board and an open board', async () => ({
    ok: staffBoard?.visibility === 'staff' && openBoard?.visibility === 'public',
    detail: `${staffBoard?.visibility}, ${openBoard?.visibility}`,
  }))

  const totalBefore = (await req('/api/boards')).body?.totalPostCount
  const hiddenCard = (await req('/api/posts', { method: 'POST', as: mgr, json: { title: `Hidden ${text}`, content: `Secret ${text}`, boardId: staffBoard.id } })).body
  const openCard = (await req('/api/posts', { method: 'POST', as: mgr, json: { title: `Open ${text}`, content: `Public ${text}`, boardId: openBoard.id } })).body
  await req(`/api/admin/posts/${hiddenCard.id}`, { method: 'PATCH', as: mgr, json: { status: 'planned' } })
  await req(`/api/admin/posts/${openCard.id}`, { method: 'PATCH', as: mgr, json: { status: 'planned' } })
  const hiddenComment = await req(`/api/posts/${hiddenCard.id}/comments`, { method: 'POST', as: mgr, json: { content: `Staff note ${tag}` } })
  await step('manager files a card on each board and the staff board refuses a comment', async () => ({
    ok: !!hiddenCard?.id && !!openCard?.id && hiddenComment.status === 403,
    detail: `comment ${hiddenComment.status}`,
  }))

  for (const [who, as] of viewers) {
    console.log(`\nAs a ${who}`)
    await step('board list leaves out the staff board, keeps the open one', async () => {
      const r = await req('/api/boards', { as })
      const names = (r.body?.data ?? []).map((b: { id: string }) => b.id)
      return { ok: !names.includes(staffBoard.id) && names.includes(openBoard.id) }
    })
    await step('board counts do not include the staff card', async () => {
      const r = await req('/api/boards', { as })
      return { ok: r.body?.totalPostCount === totalBefore + 1, detail: `${r.body?.totalPostCount} (was ${totalBefore}, one open card added)` }
    })
    await step('card list leaves the staff card out', async () => {
      const r = await req('/api/posts?pageSize=100', { as })
      return { ok: !ids(r).includes(hiddenCard.id) && ids(r).includes(openCard.id) }
    })
    await step('card list filtered to the staff board is empty', async () => {
      const r = await req(`/api/posts?boardId=${staffBoard.id}`, { as })
      return { ok: r.status === 200 && ids(r).length === 0 }
    })
    await step('search leaves the staff card out', async () => {
      const r = await req(`/api/posts/search?q=${encodeURIComponent(text)}`, { as })
      return { ok: r.status === 200 && !ids(r).includes(hiddenCard.id) && ids(r).includes(openCard.id) }
    })
    await step('similar-cards check (typed text) leaves it out', async () => {
      const r = await req('/api/posts/similar', { method: 'POST', as, json: { title: text, limit: 20 } })
      return { ok: r.status === 200 && !ids(r).includes(hiddenCard.id) }
    })
    await step('similar cards for the staff card: 404', async () => {
      const r = await req(`/api/posts/${hiddenCard.id}/similar`, { as })
      return { ok: r.status === 404, detail: String(r.status) }
    })
    await step('roadmap leaves it out', async () => {
      const r = await req('/api/roadmap', { as })
      const planned = (r.body?.planned?.data ?? []).map((p: { id: string }) => p.id)
      return { ok: r.status === 200 && !planned.includes(hiddenCard.id) && planned.includes(openCard.id) }
    })
    await step('direct read of the card by slug: 404', async () => {
      const r = await req(`/api/posts/${hiddenCard.slug}`, { as })
      return { ok: r.status === 404, detail: String(r.status) }
    })
    await step('the open card still reads', async () => {
      const r = await req(`/api/posts/${openCard.slug}`, { as })
      return { ok: r.status === 200, detail: String(r.status) }
    })
    await step('its comments: 404', async () => {
      const r = await req(`/api/posts/${hiddenCard.id}/comments`, { as })
      return { ok: r.status === 404, detail: String(r.status) }
    })
    if (as.cookie) {
      await step('voting, commenting and subscribing on it: 404', async () => {
        const v = await req(`/api/posts/${hiddenCard.id}/vote`, { method: 'POST', as })
        const c = await req(`/api/posts/${hiddenCard.id}/comments`, { method: 'POST', as, json: { content: 'hello' } })
        const s = await req(`/api/posts/${hiddenCard.id}/subscription`, { method: 'POST', as })
        return { ok: v.status === 404 && c.status === 404 && s.status === 404, detail: `${v.status}/${c.status}/${s.status}` }
      })
      await step('filing a card on the staff board: 404, nothing created', async () => {
        const r = await req('/api/posts', { method: 'POST', as, json: { title: `Sneaky ${tag}`, content: 'x', boardId: staffBoard.id } })
        return { ok: r.status === 404, detail: String(r.status) }
      })
      await step('the dashboard list leaves it out', async () => {
        const r = await req('/api/admin/posts?pageSize=100', { as })
        return { ok: r.status === 403 || (r.status === 200 && !ids(r).includes(hiddenCard.id)), detail: String(r.status) }
      })
    }
  }

  console.log('\nAs a manager')
  await step('board list shows the staff board, marked staff', async () => {
    const r = await req('/api/boards', { as: mgr })
    const b = (r.body?.data ?? []).find((x: { id: string }) => x.id === staffBoard.id)
    return { ok: b?.visibility === 'staff' }
  })
  await step('board counts include the staff card', async () => {
    const r = await req('/api/boards', { as: mgr })
    return { ok: r.body?.totalPostCount === totalBefore + 2, detail: `${r.body?.totalPostCount} (was ${totalBefore})` }
  })
  await step('card list, filtered list and search show it', async () => {
    const a = await req('/api/posts?pageSize=100', { as: mgr })
    const b = await req(`/api/posts?boardId=${staffBoard.id}`, { as: mgr })
    const c = await req(`/api/posts/search?q=${encodeURIComponent(text)}`, { as: mgr })
    return { ok: ids(a).includes(hiddenCard.id) && ids(b).includes(hiddenCard.id) && ids(c).includes(hiddenCard.id) }
  })
  await step('suggestions never offer a staff card, even to a manager', async () => {
    const typed = await req('/api/posts/similar', { method: 'POST', as: mgr, json: { title: text, limit: 20 } })
    const forOpen = await req(`/api/posts/${openCard.id}/similar?limit=10`, { as: mgr })
    const forStaff = await req(`/api/posts/${hiddenCard.id}/similar?limit=10`, { as: mgr })
    return {
      ok: typed.status === 200 && !ids(typed).includes(hiddenCard.id) && ids(typed).includes(openCard.id)
        && forOpen.status === 200 && !ids(forOpen).includes(hiddenCard.id)
        && forStaff.status === 200 && ids(forStaff).length === 0,
      detail: `typed ${ids(typed).length}, for open card ${ids(forOpen).length}, for staff card ${ids(forStaff).length}`,
    }
  })
  await step('roadmap shows it', async () => {
    const r = await req('/api/roadmap', { as: mgr })
    return { ok: (r.body?.planned?.data ?? []).some((p: { id: string }) => p.id === hiddenCard.id) }
  })
  await step('the dashboard list shows it', async () => {
    const r = await req('/api/admin/posts?pageSize=100', { as: mgr })
    return { ok: ids(r).includes(hiddenCard.id) }
  })
  await step('direct read works; a staff board takes no comments or votes (empty list, 403)', async () => {
    const a = await req(`/api/posts/${hiddenCard.slug}`, { as: mgr })
    const b = await req(`/api/posts/${hiddenCard.id}/comments`, { as: mgr })
    const c = await req(`/api/posts/${hiddenCard.id}/vote`, { method: 'POST', as: mgr })
    return { ok: a.status === 200 && b.status === 200 && (b.body?.data ?? []).length === 0 && c.status === 403, detail: `${a.status}/${b.status}/${c.status}` }
  })
  await step('widget "my feedback" lists it for its author', async () => {
    const r = await req('/api/widget/feedback', { as: mgr })
    return { ok: r.status === 200 && ids(r).includes(hiddenCard.id), detail: String(r.status) }
  })

  console.log('\nThe board setting')
  await step('switching the staff board to public shows it to everyone; back to staff hides it', async () => {
    const pub = await req(`/api/admin/boards/${staffBoard.id}`, { method: 'PATCH', as: mgr, json: { visibility: 'public' } })
    const seen = await req(`/api/posts/${hiddenCard.slug}`, { as: viewers[0]![1] })
    const back = await req(`/api/admin/boards/${staffBoard.id}`, { method: 'PATCH', as: mgr, json: { visibility: 'staff' } })
    const gone = await req(`/api/posts/${hiddenCard.slug}`, { as: viewers[0]![1] })
    return { ok: pub.body?.visibility === 'public' && seen.status === 200 && back.body?.visibility === 'staff' && gone.status === 404, detail: `${seen.status} then ${gone.status}` }
  })
  await step('an unknown visibility value is refused', async () => {
    const r = await req(`/api/admin/boards/${staffBoard.id}`, { method: 'PATCH', as: mgr, json: { visibility: 'secret' } })
    return { ok: r.status === 400 || r.status === 422, detail: String(r.status) }
  })

  if (process.env.PROBE_DATABASE_URL) {
    console.log('\nThe author of a card that lands on the staff board')
    const postgres = (await import('postgres')).default
    const sql = postgres(process.env.PROBE_DATABASE_URL, { max: 1 })
    try {
      const mine = (await req('/api/posts', { method: 'POST', as: viewers[1]![1], json: { title: `Mine ${text}`, content: 'Written by the signed-in person.', boardId: openBoard.id } })).body
      await sql`update post set board_id = ${staffBoard.id} where id = ${mine.id}`
      await step('their own card, now on the staff board, is gone for them (read and widget list)', async () => {
        const a = await req(`/api/posts/${mine.slug}`, { as: viewers[1]![1] })
        const b = await req('/api/widget/feedback', { as: viewers[1]![1] })
        return { ok: a.status === 404 && !ids(b).includes(mine.id), detail: `${a.status}` }
      })
      await sql`update post set board_id = ${openBoard.id} where id = ${mine.id}`
      await step('moved back, they see it again', async () => {
        const a = await req(`/api/posts/${mine.slug}`, { as: viewers[1]![1] })
        return { ok: a.status === 200 }
      })
    }
    finally { await sql.end() }
  }
  void userId

  console.log('\nTidying up')
  await step('a staff board that still has cards cannot be deleted (they would become public)', async () => {
    const r = await req(`/api/admin/boards/${staffBoard.id}`, { method: 'DELETE', as: mgr })
    return { ok: r.status === 409, detail: String(r.status) }
  })
  // Scratch data: make it public so the board can go, then remove the cards the probe made.
  await req(`/api/admin/boards/${staffBoard.id}`, { method: 'PATCH', as: mgr, json: { visibility: 'public' } })
  for (const c of [hiddenCard, openCard]) await req(`/api/admin/posts/${c.id}`, { method: 'DELETE', as: mgr })
  await req(`/api/admin/boards/${staffBoard.id}`, { method: 'DELETE', as: mgr })
  await req(`/api/admin/boards/${openBoard.id}`, { method: 'DELETE', as: mgr })

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
