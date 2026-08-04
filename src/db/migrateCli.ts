import { runMigrations } from './migrate'
import { waitForDatabase, closePools } from './pool'
import { logger } from '../lib/logger'

/** Runs the migrations from the command line. Used by CI and by the harness. */
async function main(): Promise<void> {
  await waitForDatabase()
  const applied = await runMigrations()
  logger.info({ applied }, 'migrations complete')
  await closePools()
}

main().catch((error) => {
  logger.error({ err: error }, 'migration run failed')
  process.exit(1)
})
