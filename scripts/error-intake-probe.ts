#!/usr/bin/env tsx
// End-to-end probe for the StaXX error intake (local/PLAN-error-intake.md,
// POST /api/apps/staxx/error-report).
//
// The claims being tested: a new error shape files exactly one card on the staff
// board "Error explanations"; the same shape again files nothing new and only
// moves the "Servers that met it" line (once per server); every malformed or
// suspicious request is refused; the day limits answer 429; and a blocked server
// is told it worked while nothing is filed. Only real requests over the wire can
// show that.
//
// Needs the board "Error explanations" (visibility staff) and STAXX_REPORTER_USER_ID
// set on the server under test, and a manager account that signs in with email and
// password. Everything is read back over HTTP as that manager — cards from the
// board's card list, server rows and blocking from /api/admin/staxx/servers — so
// the probe needs no database connection (a PGlite scratch database allows one,
// and the app holds it).
//
// Usage:
//   FEEDLOG_URL=http://localhost:3000 PROBE_MANAGER=mgr@example.com:pass \
//   pnpm dlx tsx scripts/error-intake-probe.ts
//
// Each group of requests claims its own source address through X-Real-IP so
// the 30-a-day address limit is only hit on purpose. The app trusts that header,
// so run this against a scratch server. It files about a dozen
// cards; the day limits are per day, so a second run on the same day can see 429
// where it expects 200 — use a fresh database.

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

async function send(body: unknown, ip: string, raw?: string, extra: Record<string, string> = {}): Promise<Res> {
  const res = await fetch(`${BASE}/api/apps/staxx/error-report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE, 'X-Real-IP': ip, ...extra },
    body: raw ?? JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: any = text
  try { parsed = JSON.parse(text) }
  catch { /* keep text */ }
  return { status: res.status, body: parsed }
}

const stamp = Date.now()
// Each run's shapes are unique so earlier runs cannot make "new" mean "known".
const shape = (n: number) => `validating compose.yml: services.web additional properties 'probe${n}x${stamp}' not allowed`
const good = (n: number, extra: Record<string, unknown> = {}) =>
  ({ shape: shape(n), staxxVersion: '00.05.00', composeVersion: '2.40.3', ...extra })

async function main() {
  const mgrRaw = process.env.PROBE_MANAGER || ''
  if (!mgrRaw.includes(':')) {
    console.error('PROBE_MANAGER=email:password is required')
    process.exit(1)
  }
  console.log(`Probing ${BASE}\n`)

  const i = mgrRaw.indexOf(':')
  const login = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ email: mgrRaw.slice(0, i), password: mgrRaw.slice(i + 1) }),
  })
  const cookie = login.headers.getSetCookie().map(s => s.split(';')[0]).join('; ')
  const asMgr = async (path: string, init: RequestInit = {}) => {
    const r = await fetch(`${BASE}${path}`, { ...init, headers: { Cookie: cookie, Origin: BASE, ...(init.headers as object || {}) } })
    const t = await r.text()
    let body: any = t
    try { body = JSON.parse(t) }
    catch { /* keep text */ }
    return { status: r.status, body }
  }

  const boards = (await asMgr('/api/boards')).body?.data ?? []
  const errBoard = boards.find((b: { name: string }) => b.name === 'Error explanations')
  if (!errBoard) {
    console.error('The manager cannot see a board called "Error explanations"; create it as a staff board first')
    process.exit(1)
  }
  // Cards this run filed.
  const mine = async (): Promise<Array<{ title: string; slug: string }>> =>
    ((await asMgr(`/api/posts?boardId=${errBoard.id}&pageSize=100`)).body?.data ?? [])
      .filter((c: { title: string }) => c.title.includes(`x${stamp}`))
  const cardCount = async () => (await mine()).length
  const detail = async (n: number) => {
    const c = (await mine()).find(c => c.title === `Explain: ${shape(n)}`)
    return c ? (await asMgr(`/api/posts/${c.slug}`)).body : null
  }
  const servers = async (n: number) => Number(/Servers that met it: (\d+)/.exec((await detail(n))?.content ?? '')?.[1] ?? -1)
  const serverRow = async (id: string) =>
    ((await asMgr('/api/admin/staxx/servers?pageSize=200')).body?.data ?? []).find((r: { id: string }) => r.id === id)

  console.log('Filing')
  let serverId = ''
  await step('a new shape with no server id files one card and issues an id', async () => {
    const r = await send(good(1), '10.9.0.1')
    serverId = r.body?.serverId ?? ''
    return { ok: r.status === 200 && r.body?.ok === true && /^[0-9a-f]{32}$/.test(serverId) && await cardCount() === 1, detail: `${r.status}` }
  })
  await step('the card is on the staff board, open, in the plan\'s format', async () => {
    const d = await detail(1)
    const ok = d?.status === 'open' && d?.boardId === errBoard.id && d?.title === `Explain: ${shape(1)}`
      && d?.content.includes(`    ${shape(1)}`) && d?.content.includes('Servers that met it: 1')
      && d?.content.includes('StaXX version: 00.05.00') && d?.content.includes('Docker Compose version: 2.40.3')
    return { ok: !!ok, detail: d?.status }
  })
  await step('a signed-out caller cannot see the card', async () => {
    const d = await detail(1)
    const r = await fetch(`${BASE}/api/posts/${d.slug}`, { headers: { Origin: BASE } })
    return { ok: r.status === 404, detail: String(r.status) }
  })
  await step('the same shape from the same server files nothing and keeps the count', async () => {
    const r = await send(good(1, { serverId }), '10.9.0.1')
    return { ok: r.status === 200 && r.body?.serverId === serverId && await cardCount() === 1 && await servers(1) === 1, detail: `servers ${await servers(1)}` }
  })
  await step('the same shape from a second server files nothing and the line reads 2', async () => {
    const r = await send(good(1), '10.9.0.2')
    return { ok: r.status === 200 && await cardCount() === 1 && await servers(1) === 2, detail: `servers ${await servers(1)}` }
  })
  await step('a bare "::" in ordinary text is accepted', async () => {
    const before = await cardCount()
    const r = await send(good(4, { shape: `validating compose.yml: services.web :: separator x${stamp} not allowed` }), '10.9.0.3')
    return { ok: r.status === 200 && await cardCount() === before + 1, detail: String(r.status) }
  })


  console.log('\nRefusals')
  const refuse = (name: string, body: unknown, status = 400, raw?: string) =>
    step(name, async () => {
      const before = await cardCount()
      const r = await send(body, '10.9.1.1', raw)
      return { ok: r.status === status && await cardCount() === before, detail: `${r.status}` }
    })
  await refuse('unknown field', good(2, { extra: 1 }))
  await refuse('missing shape', { staxxVersion: '00.05.00', composeVersion: '2.40.3' })
  await refuse('shape too short', good(2, { shape: 'short' }))
  await refuse('shape too long', good(2, { shape: 'x'.repeat(301) }))
  await refuse('shape on two lines', good(2, { shape: `${shape(2)}\nsecond line` }))
  await refuse('shape with a control character', good(2, { shape: `${shape(2)}\u0007` }))
  await refuse('shape with an email address', good(2, { shape: `${shape(2)} me@example.com` }))
  await refuse('shape with a web address', good(2, { shape: `${shape(2)} http://example.com/x` }))
  await refuse('shape with an IPv4 address', good(2, { shape: `${shape(2)} 192.168.1.20` }))
  await refuse('shape with an IPv6 address', good(2, { shape: `${shape(2)} fe80::1ff:fe23:4567:890a` }))
  await refuse('bad StaXX version', good(2, { staxxVersion: '0.5.0' }))
  await refuse('bad compose version', good(2, { composeVersion: 'two' }))
  await refuse('server id that is not one we issue', good(2, { serverId: 'abc' }))
  await refuse('body that is not JSON', null, 400, 'not json')
  await step('GET is not allowed', async () => {
    const r = await fetch(`${BASE}/api/apps/staxx/error-report`)
    return { ok: r.status === 404 || r.status === 405, detail: String(r.status) }
  })

  console.log('\nLimits')
  await step('the eleventh report in a day from one server is 429', async () => {
    const id = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
    const codes: number[] = []
    for (let n = 0; n < 11; n++) codes.push((await send(good(1, { serverId: id }), '10.9.2.1')).status)
    return { ok: codes.slice(0, 10).every(c => c === 200) && codes[10] === 429, detail: codes.join(',') }
  })
  await step('the thirty-first report in a day from one address is 429', async () => {
    const codes: number[] = []
    for (let n = 0; n < 31; n++) codes.push((await send(good(1), '10.9.3.1')).status)
    return { ok: codes.slice(0, 30).every(c => c === 200) && codes[30] === 429, detail: `last ${codes[30]}` }
  })

  await step('a forged first X-Forwarded-For entry does not buy a fresh allowance', async () => {
    const codes: number[] = []
    for (let n = 0; n < 31; n++) codes.push((await send(good(1), '10.9.5.1', undefined, { 'X-Forwarded-For': `1.2.3.${n}, 10.9.5.1` })).status)
    return { ok: codes.slice(0, 30).every(c => c === 200) && codes[30] === 429, detail: `last ${codes[30]}` }
  })
  await step('with no X-Real-IP the last X-Forwarded-For entry is the address', async () => {
    const codes: number[] = []
    for (let n = 0; n < 31; n++) {
      const res = await fetch(`${BASE}/api/apps/staxx/error-report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: BASE, 'X-Forwarded-For': `9.9.9.${n}, 10.9.6.1` },
        body: JSON.stringify(good(1)),
      })
      codes.push(res.status)
    }
    return { ok: codes.slice(0, 30).every(c => c === 200) && codes[30] === 429, detail: `last ${codes[30]}` }
  })

  console.log('\nBoard visibility')
  await step('a public board of that name gets 503 and nothing filed; staff again works', async () => {
    const flip = (v: string) => asMgr(`/api/admin/boards/${errBoard.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visibility: v }) })
    const before = await cardCount()
    const toPublic = await flip('public')
    const r = await send(good(5), '10.9.7.1')
    const toStaff = await flip('staff')
    const r2 = await send(good(5), '10.9.7.2')
    return { ok: toPublic.status === 200 && r.status === 503 && toStaff.status === 200 && r2.status === 200 && await cardCount() === before + 1, detail: `public ${r.status}, staff ${r2.status}` }
  })

  console.log('\nBlocking')
  let blockedId = ''
  await step('a blocked server is told ok and nothing is filed or counted', async () => {
    const id = blockedId = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
    await send(good(1, { serverId: id }), '10.9.4.1')
    const listed = await serverRow(id)
    const blocked = await asMgr(`/api/admin/staxx/servers/${id}/block`, { method: 'POST' })
    const before = await cardCount()
    const r = await send(good(3, { serverId: id }), '10.9.4.1')
    const after = await serverRow(id)
    return {
      ok: listed?.reportCount === 1 && blocked.status === 204 && r.status === 200 && r.body?.ok === true
        && await cardCount() === before && after?.blocked === true && after?.reportCount === 1,
      detail: `block ${blocked.status}, reply ${r.status}, reports ${after?.reportCount}`,
    }
  })
  await step('unblocking lets its reports be filed again', async () => {
    const u = await asMgr(`/api/admin/staxx/servers/${blockedId}/unblock`, { method: 'POST' })
    const before = await cardCount()
    const r = await send(good(3, { serverId: blockedId }), '10.9.4.1')
    return { ok: u.status === 204 && r.status === 200 && await cardCount() === before + 1, detail: `unblock ${u.status}, reply ${r.status}` }
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
