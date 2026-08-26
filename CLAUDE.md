# CLAUDE.md

Working rules for this repository. Read `AGENTS.md` for the stack and architecture; this file is
about how to work here, and what this fork exists for.

## What this fork is

A fork of `linkcraftstudio/feedlog` whose only purpose is to let an automated agent work the board
over plain HTTP with a long-lived credential. Everything else should stay as close to upstream as
possible, because the fork has to keep absorbing upstream changes cheaply.

The whole feature is: `shared/constants/agent.ts`, `server/db/schemas/agent.ts`,
`server/utils/agent-token.ts`, `server/api/developer/agent-tokens/*`,
`app/pages/dashboard/developer/agent-tokens.vue`, `app/composables/useAgentTokens.ts`, plus
one-line additions to `server/db/schemas/index.ts`, `app/composables/useDashboardNav.ts` and
`server/middleware/sso-session-guard.ts`, and a new i18n namespace.

**`server/utils/auth.ts` is deliberately untouched, and should stay that way.** An agent token is
an ordinary better-auth session presented as `Authorization: Bearer <token>`, and the `bearer()`
plugin turns that header into a session cookie before any better-auth endpoint runs. So every
existing gate — including `auth.api.hasPermission`, which `requireOrgPermission` delegates to, and
`customSession`, which supplies the `orgList` that `requireOrgMember` reads — works unmodified. If
a change starts spreading into the auth helpers or across route files, the approach has gone wrong.

Not the API-key plugin: its session short-circuits `customSession`, so `orgList` never arrives and
the `requireOrgMember` routes refuse the agent. That is by design upstream, not a bug to work
around.

## Layout, and what goes upstream

Two things live here, and they are one feature: the token (server side) and `tools/feedlog-skill`,
the skill an agent works the board with. The skill is a `SKILL.md`, an endpoint reference and one
small shell script that speaks to the board's HTTP endpoints with `curl` — no package, no
dependencies, nothing for a `pnpm install` to reach.

**A repository is not a PR.** `CONTRIBUTING.md` asks for one PR per concern, and the token patch is
the only half with a general case: small, additive, no existing auth code touched. The skill is a
client for the board, useful to whoever runs one, but not part of the board itself. So:

- `main` — everything, this fork's working state.
- `agent-tokens` — the token work alone. **This is the upstream PR branch. Keep it clean.**

Fork-specific things that must NOT ride along into an upstream PR: this file, the
`/local/` line in `.gitignore`, and `tools/`. `scripts/agent-token-probe.ts` *should* go — it is the
evidence the feature works, and the nearest thing to a test the project has.

## Working rules

- **Plan before multi-file changes.** Write the plan down, get it agreed, then write code.
- **Targeted patches, never whole-file rewrites.** Keep diffs small and reviewable; a rewrite
  destroys the upstream merge base.
- **Comments say why, not what.** The existing codebase is unusually good about this — match it.
  If a line is load-bearing for a non-obvious reason, say so (see the `overrideAll` note in
  `server/utils/agent-token.ts`).
- **British spelling** in prose and comments.
- **Explain in layman's terms.** Adrian owns and directs this project and is not a professional
  developer. Conversation with him uses plain language and short analogies — no file names, no
  function names, no line numbers. That precision belongs in plan files, in code comments, and in
  this file.

## Things that will bite you

- **i18n parity is enforced.** Every key must exist in `en.json` *and* `zh.json`; run
  `node scripts/i18n-check.mjs`. Both files are CRLF with 2-space indent — a naive rewrite reformats
  the whole file.
- **`pnpm build` fails on Windows at the very end.** The build script finishes with
  `mkdir -p && cp -r`, which cmd doesn't have. The Nuxt build itself has already succeeded by then;
  read the output rather than the exit code.
- **The repo does not typecheck cleanly**, and did not before this fork. About twenty upstream files
  have pre-existing errors. Check that *your* files are absent from the list rather than expecting
  zero errors. The root `tsconfig.json` has `files: []`, so it checks nothing — use
  `.nuxt/tsconfig.server.json` and friends.
- **There is no test framework.** Verification here is `scripts/agent-token-probe.ts`, a live HTTP
  probe that walks every authorisation tier. Don't add a test harness for a small change.
- **Migrations run at boot** (`server/plugins/migrate.ts`, advisory lock 42), so a new table needs
  no manual step in a deployed container.
- **Never put a token in a URL.** `server/plugins/access-log.ts` logs each request's path *and*
  query string.
- **Pushes do not build an image.** GitHub disables Actions on forked repositories, and enabling
  them via the API was not enough to restore the push trigger. Until someone clicks the enable
  button in the repository's Actions tab, every image build must be dispatched by hand:
  `gh workflow run "Publish Docker image" --repo quadcom/feedlog-token --ref main`.
- **Reading a card uses its slug; writing to it uses its id.** An upstream inconsistency
  (`GET /api/posts/:postId` matches on `post.slug`, everything else on `post.id`).

## The server

Adrian's Unraid box is **production**. Credentials are in `local/dev-server.md`, gitignored via
`/local/`; never copy them anywhere else. Never pull an image, start or stop a container, or edit a
stack folder there without asking first.
