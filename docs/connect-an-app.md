# Connect an app

Lets another program — StaXX's bug form, for one — post to the board **as the person using it**,
without ever seeing their password. The person approves the connection once in their browser, like
signing a TV into a streaming service; the app gets a credential tied to their own account, limited
to reporting, lasting a year, and revocable at any moment by them or by a manager.

This page is the contract an app is built against. Field names and paths here are stable; fields
may be added, none will be renamed.

## How it works

A connection is a better-auth session for the person's own user, minted with a year's expiry and
presented as `Authorization: Bearer <token>` — the same mechanism as an agent token (see
`agent-tokens.md`), except the session belongs to a real person and is narrowed:

- `server/middleware/connect-guard.ts` recognises a connected-app session and lets it read, post a
  card, check for similar cards, upload a picture, comment, and end its own connection. Everything
  else is refused, whatever the person's role.
- Card creation through a connection is capped at 10 an hour per person. Managers and owners are
  exempt.

The flow is a small version of the OAuth device flow (RFC 8628), in camelCase like the rest of the
API. It does not use better-auth's `deviceAuthorization` plugin: that would mean editing the auth
config, adding its tables, and then relabelling, lengthening and narrowing the 7-day session it
issues.

## The flow

```
App server                          FeedLog                         Person's browser
    |-- POST /api/connect/start -------->|                                  |
    |<-- userCode, deviceCode, links ----|                                  |
    |    (shows userCode + a button that opens verificationUriComplete) --->|
    |                                    |<-- signs in, presses Allow ------|
    |-- POST /api/connect/poll (every interval seconds) -->|                |
    |<-- { status: "connected", token } -|                                  |
```

The token travels server to server. It never passes through the browser, and it is never put in a
URL (the access log records every path and query string).

### 1. Start

`POST /api/connect/start` — no credential needed. Rate-limited per address.

```json
{ "app": "StaXX", "label": "Tower" }
```

- `app`: 1–40 characters. The program's name, shown on the approval page and in lists.
- `label`: 1–80 characters. Which installation this is — the server's name, say. Shown as
  **Connect StaXX on Tower?**

`201`:

```json
{
  "deviceCode": "k1b0…(43 characters, keep secret)",
  "userCode": "WDJB-MJHT",
  "verificationUri": "https://board.example.com/connect",
  "verificationUriComplete": "https://board.example.com/connect?code=WDJB-MJHT",
  "interval": 5,
  "expiresIn": 600,
  "expiresAt": "2026-09-30T18:10:00.000Z"
}
```

Show the person `userCode`, and a button that opens `verificationUriComplete`. The user code uses
letters that cannot be misread (no vowels, no 0/O or 1/I); the page accepts it in either case, with
or without the dash. It is useless on its own — it only lets a signed-in person approve.

### 2. Poll

`POST /api/connect/poll`, no more often than every `interval` seconds, until the status is final.

```json
{ "deviceCode": "k1b0…" }
```

Always `200` with a `status`:

| `status` | Meaning | Other fields |
|---|---|---|
| `pending` | Not yet approved. Keep polling. | `interval` |
| `denied` | The person pressed Deny, or cannot be connected (banned). Stop. | — |
| `expired` | Code timed out, is unknown, or was already collected. Start again. | — |
| `connected` | Done. Store the token. **Returned exactly once.** | see below |

```json
{
  "status": "connected",
  "token": "…",
  "expiresAt": "2027-09-30T18:05:12.000Z",
  "connectionId": "0199…",
  "user": { "id": "…", "name": "Adrian", "email": "adrian@example.com" }
}
```

Store `token` privately, never show it back. `expiresAt` is a year out; after that every call
answers `401` and the person connects again.

### 3. Use the token

Every request carries `Authorization: Bearer <token>`. The base URL is the board's own address.

**Find the board.** `GET /api/boards` returns `{ data: [{ id, name, … }] }`. Match on the board's
name (on the production board, bug reports go to **Bug Report**) rather than hard-coding an id.

**Upload a picture** (optional, before creating the card). `POST /api/upload`, `multipart/form-data`
with the image in a field named `file`. Images only, up to 16 MB. `200`:

```json
{ "key": "uploads/<org>/screenshot-a1b2c3.png" }
```

Put it in the card's markdown as `![screenshot](attachment:<key>)` — the same form the board's own
editor writes; it is resolved to the image's address when the card is shown.

**Check for a similar card** (optional). `POST /api/posts/similar`
`{ "title": "…", "content": "…", "limit": 3 }` returns the closest existing cards.

**Create the card.** `POST /api/posts`:

```json
{ "title": "…(1–200)", "content": "…markdown (1–10000)", "boardId": "<id from /api/boards>" }
```

`201` returns the card, including `id` (use it for comments) and `slug` (use it to link to or read
the card: `GET /api/posts/<slug>`, and the page `/p/<slug>`).

**Comment.** `POST /api/posts/<id>/comments` `{ "content": "…(1–5000)" }`.

**Attach a private file** (optional, after creating the card). For diagnostic bundles: never shown
on the public card, in any list or in search; readable only by the card's author and the
workspace's managers and owners. `POST /api/posts/<id>/attachments`, `multipart/form-data`, field
`file`. Types `text/plain` (`.txt`, `.log`), `application/json` (`.json`) or `application/zip`
(`.zip`, and it must really be a zip); the extension must match the type. Up to 5 MB a file, 5 files
a card, 20 uploads an hour a person (managers and owners exempt). Only on the person's own cards.
`201`:

```json
{ "id": "…", "filename": "diagnostics.zip", "contentType": "application/zip", "size": 48213,
  "createdAt": "…", "expiresAt": "…(90 days on)" }
```

Files are deleted after 90 days, and with their card. `GET /api/posts/<id>/attachments` lists them
(`{ data: [ … ] }`) and `GET /api/posts/<id>/attachments/<attachmentId>` downloads one, always as a
saved file. Anyone who may not see them gets `404`, as if nothing were there. A connected app cannot
delete an attachment; the person and managers can, from the card page. The app should sanitise
before uploading: FeedLog stores the bytes as sent and never looks inside.

**Check the connection.** `GET /api/auth/get-session` returns the person's user record while the
connection is alive, `null` once it is not.

**Disconnect from the app's side.** `DELETE /api/connect/current` ends the connection the request is
authenticated with. `204`. Do this when the person presses the app's own Disconnect, so the token
dies on the server too rather than only being forgotten locally.

## Errors

Every error is JSON: read `statusCode`, `message` (English, safe to show), and `data.code` where
present (stable, for the app to match on).

| When | Status | `data.code` | `message` |
|---|---|---|---|
| 11th card within the hour | `429` | `CONNECT_RATE_LIMITED` | `You have sent 10 reports this hour. Try again later.` |
| Attachment over 5 MB | `413` | `ATTACHMENT_TOO_LARGE` | `Attachments can be at most 5 MB.` |
| Attachment of another type, or extension and type disagree | `415` | `ATTACHMENT_TYPE_NOT_ALLOWED` | `Attach a .txt, .log, .json or .zip file.` |
| 6th attachment on a card | `409` | `ATTACHMENT_LIMIT_REACHED` | `A card can have at most 5 attachments.` |
| 21st attachment within the hour | `429` | `ATTACHMENT_RATE_LIMITED` | `You have attached 20 files this hour. Try again later.` |
| Too many starts from one address | `429` | `CONNECT_START_RATE_LIMITED` | `Too many connection attempts. Try again in a few minutes.` |
| Polling too fast | `429` | `CONNECT_POLL_RATE_LIMITED` | `Polling too fast. Wait the interval between polls.` |
| Anything a connection may not do | `403` | `CONNECTED_APP_FORBIDDEN` | `A connected app can only read the board, post cards, comments and pictures.` |
| Token disconnected, burnt, expired, or the person banned | `401` | — | `Authentication required` |

A `429` for the card cap carries a `Retry-After` header, in seconds. The window is the clock hour.

A `401` does not say *why* the token stopped working: disconnected by the person, burnt by a
manager, banned, or simply a year old all look the same. The app should treat it as "no longer
connected" and offer to connect again. A banned person is refused at the sign-in step on the
connect page, so they cannot reconnect.

## For the person and for managers

- **The person**: the **Connected apps** page (from their account menu, or `/connect`) lists each
  connection with when it was made and last used, and a **Disconnect**.
- **Managers and owners**: the Members page has a **Connected apps** section listing every
  connection in the workspace. For any person there: **Disconnect** one connection, **Disconnect
  their apps** (every connection, browser sign-in left alone), **Sign them out everywhere** (every
  session, browser included), and **Ban** with an optional reason and end date, or **Unban**. A ban
  also ends every session they have. Nobody acts on an owner unless they are one, and nobody bans
  themselves. Agent tokens cannot use these actions, even with the manager role.
- Ending a connection stops the app on its very next request: a bearer caller has no session
  cookie, so nothing is cached. A browser session ended by **Sign them out everywhere** or a ban
  can take up to a minute to stop, because better-auth caches a browser's session in its cookie
  for 60 seconds.
- There is no audit table to write these into, so each one is a `[connect]` line in the container
  log: the action, whose access it was, and who did it.

## Checking it

`scripts/connect-probe.ts` walks the whole contract over HTTP: 52 checks covering the flow, the
guard's refusals, the card cap, the manager exemption, private attachments (who can and cannot
see them, the limits, and — given `PROBE_DATABASE_URL` — the real file refused on the public file
route under eight spellings), every way of ending a connection, and a ban refusing sign-in. It
writes cards and bans a test account, so point it at a scratch database.

How attachments stay private: they live in blob storage under `private-attachments/`, apart from
the public uploads, and `server/middleware/attachment-files-guard.ts` refuses that folder on
`/api/files/**` — upstream's route, which serves any stored path to anyone. This assumes the blob
store itself is not publicly readable (the built-in store, or a private bucket). The hourly sweep in
`server/plugins/attachment-sweep.ts` deletes files past 90 days and files whose card is gone.

A scratch database needs no server: PGlite (Postgres compiled to WebAssembly, with the `vector` and
`pg_trgm` extensions this schema needs) behind `@electric-sql/pglite-socket` runs the migrations
and the probe. Give the app `?max=1` on its `DATABASE_URL`: PGlite has one backend, and a pool of
connections interleaving unnamed prepared statements through it fails with "bind message supplies
N parameters".
