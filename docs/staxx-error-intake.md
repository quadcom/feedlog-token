# StaXX error intake

Lets every StaXX server tell the board about a Docker Compose error it has no plain-English
explanation for, so one can be written and shipped back to all StaXX servers. It is automatic, needs
no sign-in, and files into a **hidden** board that only managers and owners can see.

This page is the contract StaXX (its `PLAN_212`) is built against. Field names and paths here are
stable; fields may be added, none will be renamed. The design is in `local/PLAN-error-intake.md`.

## Why the intake is narrow

StaXX is public code, so no key or special format shipped inside it can stay secret, and the request
is already encrypted by https. What protects the board is what the intake will accept: one short
sanitised line, a rate limit, a one-card-per-error rule, and a board nobody outside the staff can
read.

## The endpoint

`POST /api/apps/staxx/error-report` — no credential, no session. JSON only, and unknown fields are
refused.

```json
{
  "serverId": "optional, issued by an earlier reply",
  "shape": "validating <path>: services.<service> additional properties '<value>' not allowed",
  "staxxVersion": "00.05.00",
  "composeVersion": "2.40.3"
}
```

| Field | Rule |
|---|---|
| `serverId` | Optional. Omit it the first time; send what the reply gave you every time after. |
| `shape` | 10–300 characters, one line, printable text only. Must not contain an email address, an `http` address or an IPv4/IPv6 address: StaXX replaces those before sending, so one present means the sender is not StaXX. |
| `staxxVersion` | Matches `^\d{2}\.\d{2}\.\d{2}` (the plugin's two-digit version). |
| `composeVersion` | Matches `^v?\d+\.\d+\.\d+$`. |

`200`:

```json
{ "ok": true, "serverId": "…" }
```

Keep `serverId` and send it with every later report.

## The server ID

If none is sent, FeedLog issues one (random, 128 bits, 32 lowercase hex characters) and returns it.
It is stored with a created time, a last-seen time, the last source address, a report count and a
blocked flag. It is not a secret and not a login: it only lets the rate limit and blocking follow one
server instead of one address. A `serverId` that is not 32 lowercase hex characters is refused with
`400`. One that is well-formed but never issued is accepted and recorded as a new server.

## One card per shape

The shape is hashed (SHA-256). A shape never seen before files a card on the **Error explanations**
board; a known one files nothing. When a known shape arrives from a server that has not reported it
before, the card's "Servers that met it" line is rewritten with the new count; a repeat from the same
server changes nothing. The reply is the same in every case. Which server has reported which shape is
kept in the `staxx_error_sighting` table, so the count survives a restart. Shapes are handled one at a
time within a process, so two simultaneous first reports cannot both file a card.

## What a blocked server sees

Exactly the same reply as anyone else, `{ "ok": true, "serverId": "…" }`, and nothing is filed,
counted or rate-limited. It learns nothing to work around. A manager blocks and unblocks servers
(below). Blocking does not delete cards already filed.

## Rate limits

- 30 requests a day per source address. The address is `X-Real-IP` when the proxy sets it, otherwise the last `X-Forwarded-For` entry, otherwise the socket address; the first `X-Forwarded-For` entry is never used, because the sender writes it. Every request counts, valid or not, and it is checked
  before the body is read.
- 10 reports a day per server ID. Counted only for well-formed reports from servers that are not
  blocked.

Over either, the reply is `429`. A sender who drops its `serverId` gets a fresh one each time, so
the per-address limit is the real ceiling.

## Refusals

Every error is JSON: `statusCode` and `message` (English). **None of these carry a `data.code`**;
match on the status. A body that fails the field rules is refused by schema validation as a `400`
(h3's "Validation Error", with the details in `data`), so its `message` is generic.

| When | Status | `message` |
|---|---|---|
| No workspace at this address | `404` | `No workspace at this address` |
| Over 30 requests a day from one address | `429` | `Too many reports from this address today. Try again tomorrow.` |
| Body is not JSON, has an unknown field, or breaks a field rule (`serverId` not 32 hex, `shape` under 10 or over 300 characters, a malformed version) | `400` | `Validation Error` (details in `data`) |
| `shape` has a newline, tab or other control character | `400` | `shape must be one line of printable text` |
| `shape` contains an email address | `400` | `shape must not contain an email address` |
| `shape` contains an `http://` or `https://` address | `400` | `shape must not contain a web address` |
| `shape` contains an IPv4 address | `400` | `shape must not contain an IPv4 address` |
| `shape` contains an IPv6 address (a bare `::` in ordinary text is allowed) | `400` | `shape must not contain an IPv6 address` |
| Over 10 reports a day from one server ID | `429` | `Too many reports from this server today. Try again tomorrow.` |
| `STAXX_REPORTER_USER_ID` unset or naming no user, no board called "Error explanations", or that board not being `staff` | `503` | `Error reports are not set up on this server.` |

## The card

```
Title:  Explain: <shape>                       (cut to 200 characters)

Docker Compose said (names, paths and addresses removed by StaXX):

    <shape>

StaXX version: 00.05.00
Docker Compose version: 2.40.3
First seen: 2026-10-01
Servers that met it: 1
```

The status is `open` until an explanation is written. StaXX's review step then comments on the card
and moves it to `done`.

## The hidden board

Cards are filed on a board called **Error explanations**, whose visibility is `staff`. A `staff`
board, and every card, comment, vote and attachment on it, is invisible to anyone who is not a
manager or owner of the workspace: it is left out of lists, search, similar-card checks, the
roadmap, changelog suggestions, the widget and counts, and a direct read is a `404`, not a `403`.
The dashboard's board settings choose a board's visibility.

## Setup the server needs

- A board named exactly **Error explanations** in the workspace, visibility `staff`. If it is
  missing, or if its visibility is anything but `staff`, the intake answers `503`.
- A user to file the cards as (an agent-token account named **StaXX error reporter**), with its user
  id in the environment as `STAXX_REPORTER_USER_ID`. The intake writes the card straight to the
  database as that user, so no token is involved on this route and none is held anywhere, StaXX
  included. If the variable is unset or names no user, the intake answers `503` and logs why.

## Blocking a server (managers and owners)

Browser session only; agent tokens are refused, as for the other moderation routes.

- `GET /api/admin/staxx/servers?page=1&pageSize=50` returns
  `{ data: [{ id, createdAt, lastSeenAt, lastAddress, reportCount, blocked }], page, pageSize, total }`,
  newest first. `pageSize` is at most 200.
- `POST /api/admin/staxx/servers/<id>/block` and `POST /api/admin/staxx/servers/<id>/unblock` return
  `204`, or `404` for an id that does not exist. Each writes a `[staxx]` line to the container log.

There is no dashboard page; use these routes.

## Checking it

`scripts/error-intake-probe.ts` is the live probe (see the notes in `CLAUDE.md` for what it covers).
