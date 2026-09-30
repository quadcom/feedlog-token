// Connected-app constants, shared between the connect endpoints, the session
// guard (docs/connect-an-app.md is the contract an app builds against) and the
// connect page.

// How long a sign-in code stays usable. Long enough to find the tab and sign in
// with Google; short enough that a code photographed off a screen goes stale.
export const CONNECT_CODE_TTL_SECONDS = 600

// The poll interval an app is told to keep to.
export const CONNECT_POLL_INTERVAL_SECONDS = 5

// A connection lasts a year, then the person connects again (Adrian, 2026-09-30).
// Far enough out that better-auth's rolling refresh never fires either, so the
// token string the app stored never changes under it — see mintAgentSession.
export const CONNECT_SESSION_DAYS = 365

// Cards a person may create through connected apps per clock hour. Managers and
// owners are exempt: they may be triaging, not flooding.
export const CONNECT_CARDS_PER_HOUR = 10

// User codes are read off one screen and typed into another, so the alphabet has
// no vowels (no accidental words) and none of 0/O, 1/I/L, 5/S, 2/Z pairs.
export const CONNECT_CODE_ALPHABET = 'BCDFGHJKMNPQRTVWXY346789'
export const CONNECT_CODE_LENGTH = 8

export const CONNECT_APP_MAX = 40
export const CONNECT_LABEL_MAX = 80

export const CONNECTION_STATUSES = ['pending', 'approved', 'denied', 'connected', 'revoked'] as const
export type ConnectionStatus = typeof CONNECTION_STATUSES[number]

// Accept the code however it was typed: any case, with or without the dash, with
// stray spaces. Returns the canonical XXXX-XXXX form, or null if it cannot be one.
export function normaliseUserCode(input: string | null | undefined): string | null {
  if (!input) return null
  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (raw.length !== CONNECT_CODE_LENGTH) return null
  for (const ch of raw) {
    if (!CONNECT_CODE_ALPHABET.includes(ch)) return null
  }
  return `${raw.slice(0, 4)}-${raw.slice(4)}`
}
