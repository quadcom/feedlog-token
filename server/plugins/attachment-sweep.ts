import { consola } from 'consola'

const logger = consola.withTag('attachments')

// Hourly: delete private card attachments past their 90 days, and the files of
// cards that have been deleted (see sweepAttachments). Node server only, like
// migrate.ts — a Worker has no long-lived process to run a timer in. Running on
// more than one instance is harmless: each pass only deletes what is already
// due, so a second pass finds nothing.
const EVERY_MS = 60 * 60 * 1000
const FIRST_AFTER_MS = 2 * 60 * 1000

export default defineNitroPlugin((nitroApp) => {
  if (import.meta.preset !== 'node-server') return

  const run = async () => {
    try {
      const { expired, orphans } = await sweepAttachments(useDB())
      if (expired || orphans) logger.info(`swept ${expired} expired, ${orphans} orphaned`)
    }
    catch (error) {
      logger.warn('sweep failed', error)
    }
  }

  // unref: a pending sweep must never keep the process alive at shutdown.
  const first = setTimeout(run, FIRST_AFTER_MS)
  first.unref?.()
  const timer = setInterval(run, EVERY_MS)
  timer.unref?.()
  nitroApp.hooks.hook('close', () => {
    clearTimeout(first)
    clearInterval(timer)
  })
})
