import type { Server } from 'node:http'
import { config } from './config'
import { logger } from './lib/logger'
import { sleep } from './lib/sleep'
import { createApp } from './app'
import { waitForDatabase, closePools } from './db/pool'
import { runMigrations } from './db/migrate'
import type { Container } from './container'
import { redis, redisBlocking, closeRedis } from './redis/client'
import { appClock } from './lib/clock'
import { RedisProcessedStore } from './store/processedStore'
import { OutcomeHandler } from './consumer/outcomeHandler'
import { OutcomeConsumer } from './consumer/outcomeConsumer'
import { events } from './lib/sse'
import * as channelRepository from './repositories/channelRepository'

async function main(): Promise<void> {
  await waitForDatabase()
  const applied = await runMigrations()

  const { app, container } = createApp()
  container.services.health.setMigrationsComplete(true)
  logger.info({ applied: applied.length }, 'database is ready')

  const handler = new OutcomeHandler({
    windows: container.stores.windows,
    breakers: container.stores.breakers,
    processed: new RedisProcessedStore(redis, config.PROCESSED_TTL_SECONDS),
    clock: appClock,
    config: config.routing,
    // An outcome for a channel that this service does not have would build a
    // window that no decision can ever read.
    knownChannel: async (channelId) => {
      const channels = await channelRepository.listChannelsCached(appClock.now())
      return channels.some((c) => c.id === channelId)
    },
  })

  const consumer = new OutcomeConsumer(redis, redisBlocking, handler)
  await consumer.start()
  container.services.health.setConsumerRunning(true)

  const server: Server = app.listen(config.PORT, () => {
    logger.info(
      {
        port: config.PORT,
        windowMs: config.routing.windowMs,
        bucketMs: config.routing.bucketMs,
        console: `http://localhost:${config.PORT}/console/`,
      },
      'switch-service is listening',
    )
  })

  installShutdown(server, consumer, container)
}

function installShutdown(
  server: Server,
  consumer: OutcomeConsumer,
  container: Container,
): void {
  let shuttingDown = false

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info({ signal }, 'shutdown started')

    const hardExit = setTimeout(() => {
      logger.error('shutdown took too long, exiting now')
      process.exit(1)
    }, 15_000)
    hardExit.unref()

    container.services.health.setMigrationsComplete(false)
    await sleep(config.isTest ? 0 : 3_000)

    events.closeAll()
    await new Promise<void>((resolve) => server.close(() => resolve()))

    // Stop the consumer after the HTTP server. An outcome that arrives during
    // the shutdown is still worth applying.
    await consumer.stop()
    container.services.health.setConsumerRunning(false)

    await closeRedis()
    await closePools()

    clearTimeout(hardExit)
    logger.info('shutdown complete')
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled rejection')
  })
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'uncaught exception, exiting')
    process.exit(1)
  })
}

main().catch((error) => {
  logger.fatal({ err: error }, 'switch-service could not start')
  process.exit(1)
})
