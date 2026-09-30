import { z } from 'zod/v4'
import { appConnection } from '#layers/feedlog/server/db/schemas'
import {
  CONNECT_APP_MAX,
  CONNECT_CODE_TTL_SECONDS,
  CONNECT_LABEL_MAX,
  CONNECT_POLL_INTERVAL_SECONDS,
} from '#layers/feedlog/shared/constants/connect'

const schema = z.object({
  app: z.string().trim().min(1).max(CONNECT_APP_MAX),
  label: z.string().trim().min(1).max(CONNECT_LABEL_MAX),
})

// Per address: room for a few servers behind one router retrying, and far too
// few to fill the table — unused codes are swept after ten minutes.
const RATE_LIMIT = { limit: 30, windowSeconds: 600 }

// POST /api/connect/start — an app asks to be connected (no credential needed).
// Body: { app, label }. Returns the code to show the person and the device code
// the app polls with. Contract: docs/connect-an-app.md.
//
// Public on purpose, like any device flow: nothing is granted until a signed-in
// person approves the code on the connect page. The page's warning to approve
// only a code you started yourself is the defence against someone sending you
// theirs.
export default defineEventHandler(async (event) => {
  const orgId = event.context.orgId
  if (!orgId) throw createError({ statusCode: 404, message: 'No workspace at this address' })

  const ip = getRequestIP(event, { xForwardedFor: true }) || 'unknown'
  if (!await checkRateLimit(`connect-start:${ip}`, RATE_LIMIT)) {
    throw createError({
      statusCode: 429,
      message: 'Too many connection attempts. Try again in a few minutes.',
      data: { code: 'CONNECT_START_RATE_LIMITED' },
    })
  }

  const body = await readValidatedBody(event, schema.parse)
  const db = useDB()
  await sweepStaleCodes(db)

  const deviceCode = generateDeviceCode()
  const codeExpiresAt = new Date(Date.now() + CONNECT_CODE_TTL_SECONDS * 1000)

  // A user-code collision is a unique-index error; with 24^8 codes and ten
  // minutes of life it is vanishingly rare, but a retry costs nothing.
  let userCode = ''
  for (let attempt = 0; ; attempt++) {
    userCode = generateUserCode()
    try {
      await db.insert(appConnection).values({
        orgId,
        app: body.app,
        label: body.label,
        userCode,
        deviceCodeHash: hashDeviceCode(deviceCode),
        status: 'pending',
        codeExpiresAt,
      })
      break
    }
    catch (err) {
      if (attempt >= 2) throw err
    }
  }

  const base = publicBaseUrl(event)
  setResponseStatus(event, 201)
  return {
    deviceCode,
    userCode,
    verificationUri: `${base}/connect`,
    verificationUriComplete: `${base}/connect?code=${userCode}`,
    interval: CONNECT_POLL_INTERVAL_SECONDS,
    expiresIn: CONNECT_CODE_TTL_SECONDS,
    expiresAt: codeExpiresAt.toISOString(),
  }
})
