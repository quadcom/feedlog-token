#!/usr/bin/env tsx
// End-to-end probe for connected apps (docs/connect-an-app.md).
//
// The claims being tested: an app can be connected to a person's own account
// through a sign-in code; the credential it gets posts as that person but is
// held to reporting whatever their role; ten cards an hour is the cap except for
// managers; every way of ending a connection — the person, the app, a manager,
// a sign-out everywhere, a ban — takes effect on the very next request; and a
// card's private attachments reach its author and staff and nobody else
// (local/PLAN-private-attachments.md). Like agent-token-probe.ts, only real
// requests over the wire can show that.
//
// Needs three accounts that sign in with email and password: a board user with
// no workspace role, a second board user (the one who gets banned), and a
// manager. An owner is optional; with it, the "a manager cannot act on an owner"
// check runs too.
//
// Usage:
//   FEEDLOG_URL=http://localhost:3000 \
//   PROBE_USER=alice@example.com:pass PROBE_USER2=bob@example.com:pass \
//   PROBE_MANAGER=mgr@example.com:pass [PROBE_OWNER=owner@example.com:pass] \
//   [PROBE_DATABASE_URL=postgres://...] \
//   pnpm dlx tsx scripts/connect-probe.ts
//
// With PROBE_DATABASE_URL the attachment checks go further: they read a file's
// real storage key (never sent to any client) to try it on the public file
// route, and move a file's expiry into the past.
//
// It creates about two dozen cards, bans and unbans the second user, and signs
// the first out everywhere. Run it against a scratch database, never production.
// The card cap is per clock hour, so a run straddling the hour can see the 11th
// card accepted; run it again.

const BASE = (process.env.FEEDLOG_URL || 'http://localhost:3000').replace(/\/$/, '')

function creds(name: string, required = true): { email: string; password: string } | null {
  const raw = process.env[name] || ''
  const i = raw.indexOf(':')
  if (i < 0) {
    if (required) {
      console.error(`${name}=email:password is required`)
      process.exit(1)
    }
    return null
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

interface Res { status: number; body: any; headers: Headers }

// A caller is either a browser (a cookie) or an app (a bearer token), never both
// unless a step sets both on purpose.
interface Caller { cookie?: string; token?: string }

async function req(path: string, init: RequestInit & { as?: Caller; json?: unknown } = {}): Promise<Res> {
  const { as, json, ...rest } = init
  const headers: Record<string, string> = { Origin: BASE, ...(rest.headers as Record<string, string> || {}) }
  if (json !== undefined) headers['Content-Type'] = 'application/json'
  if (as?.cookie) headers.Cookie = as.cookie
  if (as?.token) headers.Authorization = `Bearer ${as.token}`
  const res = await fetch(`${BASE}${path}`, {
    ...rest,
    headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  })
  const text = await res.text()
  let body: any = text
  try { body = JSON.parse(text) }
  catch { /* keep text */ }
  return { status: res.status, body, headers: res.headers }
}

async function signIn(c: { email: string; password: string }): Promise<Res & { cookie: string }> {
  const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify(c),
  })
  const cookie = res.headers.getSetCookie().map(s => s.split(';')[0]).join('; ')
  const text = await res.text()
  let body: any = text
  try { body = JSON.parse(text) }
  catch { /* keep text */ }
  return { status: res.status, body, headers: res.headers, cookie }
}

// start → approve as `person` → poll. Returns the token and connection id.
async function connect(person: Caller, label: string): Promise<{ token: string; id: string }> {
  const s = await req('/api/connect/start', { method: 'POST', json: { app: 'Probe', label } })
  if (s.status !== 201) throw new Error(`start ${s.status}`)
  const a = await req('/api/connect/approve', { method: 'POST', as: person, json: { code: s.body.userCode } })
  if (a.status !== 200) throw new Error(`approve ${a.status} ${JSON.stringify(a.body)}`)
  const p = await req('/api/connect/poll', { method: 'POST', json: { deviceCode: s.body.deviceCode } })
  if (p.body?.status !== 'connected') throw new Error(`poll ${JSON.stringify(p.body)}`)
  return { token: p.body.token, id: p.body.connectionId }
}

function card(n: number) {
  return { title: `Probe card ${n} ${Date.now()}`, content: 'Filed by scripts/connect-probe.ts.', boardId: undefined as string | undefined }
}

// A file part for multipart uploads.
function filePart(name: string, type: string, data: Uint8Array | string): FormData {
  const form = new FormData()
  form.append('file', new Blob([data], { type }), name)
  return form
}
// The smallest valid zip: an empty archive's end-of-central-directory record.
const EMPTY_ZIP = Uint8Array.from([0x50, 0x4B, 0x05, 0x06, ...Array.from({ length: 18 }, () => 0)])

const is403 = (r: Res) => r.status === 403 && r.body?.data?.code === 'CONNECTED_APP_FORBIDDEN'

async function main() {
  const userC = creds('PROBE_USER')!
  const user2C = creds('PROBE_USER2')!
  const mgrC = creds('PROBE_MANAGER')!
  const ownerC = creds('PROBE_OWNER', false)

  console.log(`Probing ${BASE}\n`)

  const alice = { cookie: (await signIn(userC)).cookie }
  const bob = { cookie: (await signIn(user2C)).cookie }
  const mgr = { cookie: (await signIn(mgrC)).cookie }
  const owner = ownerC ? { cookie: (await signIn(ownerC)).cookie } : null
  const aliceId = (await req('/api/auth/get-session', { as: alice })).body?.user?.id
  const bobId = (await req('/api/auth/get-session', { as: bob })).body?.user?.id
  const mgrId = (await req('/api/auth/get-session', { as: mgr })).body?.user?.id
  const ownerId = owner ? (await req('/api/auth/get-session', { as: owner })).body?.user?.id : null
  if (!aliceId || !bobId || !mgrId) throw new Error('could not sign the probe accounts in')

  const boards = (await req('/api/boards')).body?.data ?? []
  const bugBoard = boards.find((b: { name: string }) => b.name === 'Bug Report')?.id ?? boards[0]?.id

  console.log('Connecting')
  let start: Res = { status: 0, body: null, headers: new Headers() }
  await step('start returns a code, a device code and the connect links', async () => {
    start = await req('/api/connect/start', { method: 'POST', json: { app: 'Probe', label: 'Test server' } })
    const b = start.body
    const ok = start.status === 201 && /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(b?.userCode) && b?.deviceCode?.length >= 40
      && b?.verificationUriComplete?.endsWith(`/connect?code=${b.userCode}`) && b?.interval === 5 && b?.expiresIn === 600
    return { ok, detail: `${start.status} ${b?.userCode}` }
  })
  await step('poll before approval is pending', async () => {
    const r = await req('/api/connect/poll', { method: 'POST', json: { deviceCode: start.body.deviceCode } })
    return { ok: r.body?.status === 'pending', detail: JSON.stringify(r.body) }
  })
  await step('lookup is refused when a bearer header rides along', async () => {
    const r = await req('/api/connect/lookup', { method: 'POST', as: { ...alice, token: 'x' }, json: { code: start.body.userCode } })
    return { ok: r.status === 403, detail: String(r.status) }
  })
  await step('lookup is refused when signed out', async () => {
    const r = await req('/api/connect/lookup', { method: 'POST', json: { code: start.body.userCode } })
    return { ok: r.status === 401, detail: String(r.status) }
  })
  await step('lookup, signed in, names the app — any case, no dash', async () => {
    const code = (start.body.userCode as string).replace('-', '').toLowerCase()
    const r = await req('/api/connect/lookup', { method: 'POST', as: alice, json: { code } })
    return { ok: r.status === 200 && r.body?.app === 'Probe' && r.body?.label === 'Test server', detail: JSON.stringify(r.body) }
  })
  await step('approve', async () => {
    const r = await req('/api/connect/approve', { method: 'POST', as: alice, json: { code: start.body.userCode } })
    return { ok: r.status === 200, detail: String(r.status) }
  })
  await step('the same code cannot be approved twice', async () => {
    const r = await req('/api/connect/approve', { method: 'POST', as: bob, json: { code: start.body.userCode } })
    return { ok: r.status === 404, detail: String(r.status) }
  })
  let token = ''
  let connectionId = ''
  await step('poll after approval hands over the token, a year out, naming the person', async () => {
    const r = await req('/api/connect/poll', { method: 'POST', json: { deviceCode: start.body.deviceCode } })
    token = r.body?.token ?? ''
    connectionId = r.body?.connectionId ?? ''
    const days = (new Date(r.body?.expiresAt).getTime() - Date.now()) / 86_400_000
    const ok = r.body?.status === 'connected' && !!token && days > 364 && days < 366 && r.body?.user?.id === aliceId
    return { ok, detail: `${r.body?.status}, ${Math.round(days)} days` }
  })
  await step('a second poll gets nothing (token handed over once)', async () => {
    const r = await req('/api/connect/poll', { method: 'POST', json: { deviceCode: start.body.deviceCode } })
    return { ok: r.body?.status === 'expired', detail: JSON.stringify(r.body) }
  })
  const app = { token }

  console.log('\nReporting as the person')
  await step('get-session shows the person', async () => {
    const r = await req('/api/auth/get-session', { as: app })
    return { ok: r.body?.user?.id === aliceId, detail: r.body?.user?.email }
  })
  let key = ''
  await step('upload a picture', async () => {
    // 1x1 transparent PNG.
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='), c => c.charCodeAt(0))
    const form = new FormData()
    form.append('file', new Blob([png], { type: 'image/png' }), 'screenshot.png')
    const r = await req('/api/upload', { method: 'POST', as: app, body: form })
    key = r.body?.key ?? ''
    return { ok: r.status === 200 && !!key, detail: key }
  })
  await step('similar-cards check', async () => {
    const r = await req('/api/posts/similar', { method: 'POST', as: app, json: { title: 'probe' } })
    return { ok: r.status === 200, detail: String(r.status) }
  })
  let postId = ''
  let postSlug = ''
  await step('create a card, authored by the person', async () => {
    const r = await req('/api/posts', {
      method: 'POST',
      as: app,
      json: { ...card(1), content: `With a picture: ![screenshot](attachment:${key})`, boardId: bugBoard },
    })
    postId = r.body?.id ?? ''
    postSlug = r.body?.slug ?? ''
    return { ok: r.status === 201 && r.body?.author?.id === aliceId, detail: `${r.status} ${r.body?.slug}` }
  })
  await step('comment on it', async () => {
    const r = await req(`/api/posts/${postId}/comments`, { method: 'POST', as: app, json: { content: 'Probe comment' } })
    return { ok: r.status === 200 || r.status === 201, detail: String(r.status) }
  })

  console.log('\nHeld to reporting')
  await step('cannot edit a card', async () => {
    const r = await req(`/api/posts/${postId}`, { method: 'PATCH', as: app, json: { title: 'changed' } })
    return { ok: is403(r), detail: `${r.status} ${r.body?.message}` }
  })
  await step('cannot vote', async () => {
    const r = await req(`/api/posts/${postId}/vote`, { method: 'POST', as: app })
    return { ok: is403(r), detail: String(r.status) }
  })
  await step('cannot read staff pages', async () => {
    const r = await req('/api/admin/posts', { as: app })
    return { ok: is403(r), detail: String(r.status) }
  })
  await step('cannot slip past with /api//admin or /API/admin', async () => {
    const a = await req('/api//admin/posts', { as: app })
    const b = await req('/API/admin/posts', { as: app })
    const c = await req('/api/%61dmin/posts', { as: app })
    return { ok: a.status !== 200 && b.status !== 200 && c.status !== 200, detail: `${a.status} ${b.status} ${c.status}` }
  })
  await step('cannot list the person\'s sessions (would leak their browser token)', async () => {
    const r = await req('/api/auth/list-sessions', { as: app })
    return { ok: is403(r), detail: String(r.status) }
  })
  await step('cannot change the account', async () => {
    const r = await req('/api/auth/update-user', { method: 'POST', as: app, json: { name: 'hijacked' } })
    return { ok: is403(r), detail: String(r.status) }
  })
  await step('cannot list or end the person\'s other connections', async () => {
    const a = await req('/api/connect', { as: app })
    const b = await req(`/api/connect/${connectionId}`, { method: 'DELETE', as: app })
    return { ok: is403(a) && is403(b), detail: `${a.status} ${b.status}` }
  })
  await step('cannot approve another connection', async () => {
    const s = await req('/api/connect/start', { method: 'POST', json: { app: 'Probe', label: 'Other' } })
    const r = await req('/api/connect/approve', { method: 'POST', as: app, json: { code: s.body.userCode } })
    return { ok: r.status === 403, detail: String(r.status) }
  })

  console.log('\nTen cards an hour')
  await step('cards 2 to 10 are accepted', async () => {
    const statuses: number[] = []
    for (let n = 2; n <= 10; n++) statuses.push((await req('/api/posts', { method: 'POST', as: app, json: { ...card(n), boardId: bugBoard } })).status)
    return { ok: statuses.every(s => s === 201), detail: statuses.join(',') }
  })
  await step('the 11th is refused with the app-facing message and Retry-After', async () => {
    const r = await req('/api/posts', { method: 'POST', as: app, json: { ...card(11), boardId: bugBoard } })
    const retry = Number(r.headers.get('retry-after'))
    const ok = r.status === 429 && r.body?.data?.code === 'CONNECT_RATE_LIMITED'
      && r.body?.message === 'You have sent 10 reports this hour. Try again later.' && retry > 0 && retry <= 3600
    return { ok, detail: `${r.status} retry-after=${retry}` }
  })
  await step('the person can still post in their browser', async () => {
    const r = await req('/api/posts', { method: 'POST', as: alice, json: { ...card(12), boardId: bugBoard } })
    return { ok: r.status === 201, detail: String(r.status) }
  })
  await step('a manager\'s app is exempt: 11 cards accepted', async () => {
    const m = await connect(mgr, 'Manager server')
    const statuses: number[] = []
    for (let n = 1; n <= 11; n++) statuses.push((await req('/api/posts', { method: 'POST', as: { token: m.token }, json: { ...card(n), boardId: bugBoard } })).status)
    const moderate = await req(`/api/posts/${postId}`, { method: 'PATCH', as: { token: m.token }, json: { status: 'planned' } })
    return { ok: statuses.every(s => s === 201) && is403(moderate), detail: `${statuses.join(',')}; moderate ${moderate.status}` }
  })

  console.log('\nPrivate attachments')
  const dbUrl = process.env.PROBE_DATABASE_URL
  const sql = dbUrl ? (await import('postgres')).default(dbUrl, { max: 1 }) : null
  const attIds: string[] = []
  await step('the app attaches a .txt, a .json and a .zip to its own card', async () => {
    const statuses: number[] = []
    for (const [name, type, data] of [
      ['compose-output.txt', 'text/plain', 'line 1\nline 2'],
      ['versions.json', 'application/json', '{"staxx":"1.0"}'],
      ['diagnostics.zip', 'application/zip', EMPTY_ZIP],
    ] as const) {
      const r = await req(`/api/posts/${postId}/attachments`, { method: 'POST', as: app, body: filePart(name, type, data) })
      statuses.push(r.status)
      if (r.body?.id) attIds.push(r.body.id)
    }
    return { ok: statuses.every(x => x === 201), detail: statuses.join(',') }
  })
  await step('the author and a manager see all three; the download is a forced save', async () => {
    const a = await req(`/api/posts/${postId}/attachments`, { as: alice })
    const m = await req(`/api/posts/${postId}/attachments`, { as: mgr })
    const d = await fetch(`${BASE}/api/posts/${postId}/attachments/${attIds[0]}`, { headers: { Cookie: mgr.cookie! } })
    const text = await d.text()
    const ok = a.body?.data?.length === 3 && m.body?.data?.length === 3 && d.status === 200 && text === 'line 1\nline 2'
      && /^attachment;/.test(d.headers.get('content-disposition') ?? '') && d.headers.get('x-content-type-options') === 'nosniff'
    return { ok, detail: `author ${a.body?.data?.length}, manager ${m.body?.data?.length}, download ${d.status}` }
  })
  await step('another board user and a signed-out visitor get 404 on list and download', async () => {
    const codes = [
      (await req(`/api/posts/${postId}/attachments`, { as: bob })).status,
      (await req(`/api/posts/${postId}/attachments/${attIds[0]}`, { as: bob })).status,
      (await req(`/api/posts/${postId}/attachments`)).status,
      (await req(`/api/posts/${postId}/attachments/${attIds[0]}`)).status,
    ]
    return { ok: codes.every(c => c === 404), detail: codes.join(',') }
  })
  await step('the card and the card list carry no trace of attachments', async () => {
    const list = (await req('/api/posts?limit=50')).body
    const detail = await req(`/api/posts/${postSlug}`, { as: mgr })
    const text = JSON.stringify(list) + JSON.stringify(detail.body)
    const leaked = /compose-output|versions\.json|diagnostics\.zip|private-attachments/i.test(text)
    return { ok: detail.status === 200 && !leaked, detail: `card ${detail.status}, leaked=${leaked}` }
  })
  await step('wrong type, mismatched extension and a fake zip are refused (415)', async () => {
    const tries: [string, string, string][] = [
      ['run.exe', 'application/octet-stream', 'MZ'],
      ['notes.txt', 'application/zip', 'hello'],
      ['fake.zip', 'application/zip', 'not a zip'],
      ['page.html', 'text/html', '<script>'],
    ]
    const codes: number[] = []
    for (const [name, type, data] of tries) {
      codes.push((await req(`/api/posts/${postId}/attachments`, { method: 'POST', as: app, body: filePart(name, type, data) })).status)
    }
    return { ok: codes.every(c => c === 415), detail: codes.join(',') }
  })
  await step('over 5 MB is refused (413)', async () => {
    const big = new Uint8Array(5 * 1024 * 1024 + 10).fill(0x61)
    const r = await req(`/api/posts/${postId}/attachments`, { method: 'POST', as: app, body: filePart('big.log', 'text/plain', big) })
    return { ok: r.status === 413 && r.body?.data?.code === 'ATTACHMENT_TOO_LARGE', detail: String(r.status) }
  })
  await step('the 6th file on a card is refused (409)', async () => {
    const codes: number[] = []
    for (let n = 4; n <= 6; n++) {
      codes.push((await req(`/api/posts/${postId}/attachments`, { method: 'POST', as: app, body: filePart(`log-${n}.log`, 'text/plain', `log ${n}`) })).status)
    }
    return { ok: codes[0] === 201 && codes[1] === 201 && codes[2] === 409, detail: codes.join(',') }
  })
  await step('nobody attaches to someone else\'s card (404)', async () => {
    const other = await req('/api/posts', { method: 'POST', as: bob, json: { ...card(0), boardId: bugBoard } })
    const r = await req(`/api/posts/${other.body?.id}/attachments`, { method: 'POST', as: app, body: filePart('x.txt', 'text/plain', 'x') })
    return { ok: r.status === 404, detail: String(r.status) }
  })
  await step('the app cannot delete a file; the author can', async () => {
    const a = await req(`/api/posts/${postId}/attachments/${attIds[1]}`, { method: 'DELETE', as: app })
    const b = await req(`/api/posts/${postId}/attachments/${attIds[1]}`, { method: 'DELETE', as: alice })
    const left = (await req(`/api/posts/${postId}/attachments`, { as: alice })).body?.data?.length
    return { ok: is403(a) && b.status === 204 && left === 4, detail: `app ${a.status}, author ${b.status}, ${left} left` }
  })
  if (sql) {
    await step('the real file cannot be fetched from the public file route, however it is spelt', async () => {
      const [row] = await sql`select storage_key from card_attachment where id = ${attIds[0]!}`
      const key = row!.storage_key as string
      const tail = key.slice('private-attachments/'.length)
      const variants = [
        `/api/files/${key}`,
        `/api/files/${key.toUpperCase()}`,
        `/api/files//${key}`,
        `/api/files/uploads/../${key}`,
        `/api/files/%70rivate-attachments/${tail}`,
        `/api/files/%2570rivate-attachments/${tail}`,
        `/api/files/private-attachments%2F${tail}`,
        `/API/FILES/${key}`,
      ]
      const codes: number[] = []
      for (const v of variants) codes.push((await fetch(`${BASE}${v}`)).status)
      return { ok: codes.every(c => c !== 200), detail: codes.join(',') }
    })
    await step('a file past its 90 days is gone from the list and the download', async () => {
      await sql`update card_attachment set expires_at = now() - interval '1 minute' where id = ${attIds[2]!}`
      const list = (await req(`/api/posts/${postId}/attachments`, { as: mgr })).body?.data ?? []
      const d = await req(`/api/posts/${postId}/attachments/${attIds[2]}`, { as: mgr })
      return { ok: !list.some((x: { id: string }) => x.id === attIds[2]) && d.status === 404, detail: `${list.length} listed, download ${d.status}` }
    })
  }
  await step('deleting the card deletes its attachments', async () => {
    const del = await req(`/api/admin/posts/${postId}`, { method: 'DELETE', as: mgr })
    let rows = -1
    if (sql) rows = Number((await sql`select count(*)::int as n from card_attachment where post_id = ${postId}`)[0]!.n)
    const list = await req(`/api/posts/${postId}/attachments`, { as: mgr })
    return { ok: del.status === 204 && list.status === 404 && (rows === -1 || rows === 0), detail: `delete ${del.status}, rows ${rows}` }
  })
  await sql?.end()

  console.log('\nEnding connections')
  await step('deny: the app is told denied', async () => {
    const s = await req('/api/connect/start', { method: 'POST', json: { app: 'Probe', label: 'Denied' } })
    await req('/api/connect/deny', { method: 'POST', as: alice, json: { code: s.body.userCode } })
    const r = await req('/api/connect/poll', { method: 'POST', json: { deviceCode: s.body.deviceCode } })
    return { ok: r.body?.status === 'denied', detail: JSON.stringify(r.body) }
  })
  await step('the person sees and disconnects their app; its next call is 401', async () => {
    const list = await req('/api/connect', { as: alice })
    const listed = (list.body?.data ?? []).some((c: { id: string; status: string }) => c.id === connectionId && c.status === 'connected')
    const d = await req(`/api/connect/${connectionId}`, { method: 'DELETE', as: alice })
    const after = await req('/api/posts', { method: 'POST', as: app, json: { ...card(0), boardId: bugBoard } })
    return { ok: listed && d.status === 204 && after.status === 401, detail: `listed=${listed} ${d.status} then ${after.status}` }
  })
  await step('the app disconnects itself; its next call is 401', async () => {
    const c = await connect(alice, 'Self-disconnect')
    const d = await req('/api/connect/current', { method: 'DELETE', as: { token: c.token } })
    const s = await req('/api/auth/get-session', { as: { token: c.token } })
    return { ok: d.status === 204 && s.body === null, detail: `${d.status}, session ${JSON.stringify(s.body)}` }
  })
  await step('a manager sees and burns one connection; its next call is 401', async () => {
    const c = await connect(alice, 'Burnt by manager')
    const list = await req('/api/admin/connections', { as: mgr })
    const listed = (list.body?.data ?? []).some((x: { id: string }) => x.id === c.id)
    const d = await req(`/api/admin/connections/${c.id}`, { method: 'DELETE', as: mgr })
    const after = await req('/api/posts', { method: 'POST', as: { token: c.token }, json: { ...card(0), boardId: bugBoard } })
    return { ok: listed && d.status === 204 && after.status === 401, detail: `listed=${listed} ${d.status} then ${after.status}` }
  })
  await step('a manager disconnects all of a person\'s apps; browser sign-in survives', async () => {
    const c1 = await connect(alice, 'One')
    const c2 = await connect(alice, 'Two')
    const d = await req(`/api/admin/people/${aliceId}/disconnect-apps`, { method: 'POST', as: mgr })
    const a1 = await req('/api/auth/get-session', { as: { token: c1.token } })
    const a2 = await req('/api/auth/get-session', { as: { token: c2.token } })
    const browser = await req('/api/auth/get-session', { as: alice })
    return { ok: d.body?.count === 2 && a1.body === null && a2.body === null && browser.body?.user?.id === aliceId, detail: `count=${d.body?.count}` }
  })
  await step('staff actions refuse an agent-style bearer caller', async () => {
    const c = await connect(mgr, 'Bearer staff')
    const r = await req(`/api/admin/people/${aliceId}/sign-out`, { method: 'POST', as: { token: c.token } })
    return { ok: r.status === 403, detail: String(r.status) }
  })
  await step('a manager cannot act on themself', async () => {
    const r = await req(`/api/admin/people/${mgrId}/sign-out`, { method: 'POST', as: mgr })
    return { ok: r.status === 400, detail: String(r.status) }
  })
  if (owner && ownerId) {
    await step('a manager cannot act on an owner', async () => {
      const r = await req(`/api/admin/people/${ownerId}/sign-out`, { method: 'POST', as: mgr })
      return { ok: r.status === 403, detail: String(r.status) }
    })
  }
  await step('a board user cannot use the staff actions', async () => {
    const r = await req(`/api/admin/people/${bobId}/ban`, { method: 'POST', as: alice, json: {} })
    // better-auth answers a non-member's permission check with 401, a member's with 403.
    return { ok: r.status === 401 || r.status === 403, detail: String(r.status) }
  })
  await step('sign out everywhere ends the browser session and the apps', async () => {
    const c = await connect(alice, 'Before sign-out')
    const d = await req(`/api/admin/people/${aliceId}/sign-out`, { method: 'POST', as: mgr })
    // The browser's 60-second session cookie cache would answer from the cookie;
    // ask the database. Once the cache runs out, every request sees it gone.
    const browser = await req('/api/auth/get-session?disableCookieCache=true', { as: alice })
    const appS = await req('/api/auth/get-session', { as: { token: c.token } })
    return { ok: d.status === 200 && browser.body === null && appS.body === null, detail: String(d.status) }
  })

  console.log('\nBanning')
  await step('ban ends the person\'s app and browser sessions', async () => {
    const c = await connect(bob, 'Banned server')
    const d = await req(`/api/admin/people/${bobId}/ban`, { method: 'POST', as: mgr, json: { reason: 'probe' } })
    const appS = await req('/api/posts', { method: 'POST', as: { token: c.token }, json: { ...card(0), boardId: bugBoard } })
    const browser = await req('/api/auth/get-session?disableCookieCache=true', { as: bob })
    return { ok: d.status === 200 && appS.status === 401 && browser.body === null, detail: `${d.status}, app ${appS.status}` }
  })
  await step('a banned person cannot sign in again', async () => {
    const r = await signIn(user2C)
    return { ok: r.status === 403 && r.body?.code === 'BANNED_USER', detail: `${r.status} ${r.body?.code}` }
  })
  await step('the ban is listed for the manager', async () => {
    const r = await req('/api/admin/connections', { as: mgr })
    return { ok: (r.body?.banned ?? []).some((b: { id: string }) => b.id === bobId), detail: String(r.status) }
  })
  await step('unban lets them sign in again', async () => {
    const d = await req(`/api/admin/people/${bobId}/unban`, { method: 'POST', as: mgr })
    const r = await signIn(user2C)
    return { ok: d.status === 200 && r.status === 200, detail: `${d.status}, sign-in ${r.status}` }
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
