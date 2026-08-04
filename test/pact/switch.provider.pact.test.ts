import type { Server } from 'node:http'
import { describe, it, beforeAll, afterAll } from 'vitest'
import { Verifier } from '@pact-foundation/pact'
import {
  brokerUrl,
  brokerUsername,
  brokerPassword,
  gitBranch,
  gitVersion,
  publishVerificationResult,
} from './pactVersion'

/**
 * PAIR 1 — the HTTP contract, provider side.
 *
 *   consumer  disbursement-service   (a different repository)
 *   provider  switch-service         (this repository)
 *
 * This test reads the contract FROM THE BROKER. There is no pact file in this
 * repository for this pair, and there must never be one. A checked-in copy
 * would go stale and this test would pass while the real consumer breaks.
 *
 * The test starts a real instance of this service against the test database
 * and a separate Redis database, then replays every interaction.
 */

// The environment must be set BEFORE the service modules load, because the
// configuration is read once, at import time.
process.env.NODE_ENV = 'test'
process.env.PORT = process.env.PACT_PROVIDER_PORT ?? '4099'
process.env.DATABASE_URL =
  process.env.PACT_DATABASE_URL ??
  'postgres://pact:pact@localhost:5434/switch_test_db'
process.env.DATABASE_READ_URL = process.env.DATABASE_URL
// Redis database 1, so a verification run never touches the demo data.
process.env.REDIS_URL = process.env.PACT_REDIS_URL ?? 'redis://localhost:6380/1'
// Exploration would send some payouts to a channel that is not the best, and
// one interaction names an exact channel. The contract says nothing about
// exploration, so the verification turns it off and stays deterministic.
process.env.EXPLORATION_RATE = '0'
process.env.LOG_LEVEL = process.env.PACT_LOG_LEVEL ?? 'error'

const PORT = Number(process.env.PORT)

let server: Server
let deps: Awaited<ReturnType<typeof loadService>>

async function loadService() {
  const [
    { createApp },
    { waitForDatabase, closePools },
    { runMigrations },
    { redis, closeRedis },
    channelRepository,
    decisionRepository,
    { appClock },
  ] = await Promise.all([
    import('../../src/app'),
    import('../../src/db/pool'),
    import('../../src/db/migrate'),
    import('../../src/redis/client'),
    import('../../src/repositories/channelRepository'),
    import('../../src/repositories/decisionRepository'),
    import('../../src/lib/clock'),
  ])
  return {
    createApp,
    waitForDatabase,
    closePools,
    runMigrations,
    redis,
    closeRedis,
    channelRepository,
    decisionRepository,
    appClock,
  }
}

const CHANNELS = [
  { id: 'RAIL-A', name: 'Alpha Bank Rail', cost: 1.2, enabled: true },
  { id: 'RAIL-B', name: 'Beta Payments Rail', cost: 1.0, enabled: true },
  { id: 'RAIL-C', name: 'Gamma Switch Rail', cost: 0.8, enabled: true },
]

/**
 * Clears everything that a state could have left behind.
 *
 * Every state calls this first. A state that depends on a different state is
 * the most common cause of a verification that passes alone and fails in the
 * suite.
 */
async function resetAll(): Promise<void> {
  deps.appClock.reset()
  await deps.redis.flushdb()
  await deps.channelRepository.deleteAllChannels()
  await deps.decisionRepository.truncateDecisions()
  deps.channelRepository.clearChannelCache()
}

async function seedChannels(): Promise<void> {
  for (const channel of CHANNELS) {
    await deps.channelRepository.upsertChannel(channel)
  }
}

/** Writes a window straight into Redis, so a state is exact and instant. */
async function writeWindow(
  channelId: string,
  success: number,
  failure: number,
  latencyMs: number,
): Promise<void> {
  const { config } = await import('../../src/config')
  const now = deps.appClock.now()
  const bucketId = Math.floor(now / config.routing.bucketMs)
  const key = `sw:${channelId}:${bucketId}`
  const latKey = `${key}:lat`
  const pipeline = deps.redis.multi()
  if (success > 0) pipeline.hincrby(key, 'success', success)
  if (failure > 0) pipeline.hincrby(key, 'failure', failure)
  for (let i = 0; i < Math.min(success + failure, 50); i += 1) {
    pipeline.lpush(latKey, String(latencyMs))
  }
  pipeline.expire(key, 300)
  pipeline.expire(latKey, 300)
  await pipeline.exec()
}

beforeAll(async () => {
  deps = await loadService()
  await deps.waitForDatabase()
  await deps.runMigrations()
  const { app } = deps.createApp()
  await new Promise<void>((resolve) => {
    server = app.listen(PORT, () => resolve())
  })
}, 60_000)

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  await deps?.closeRedis()
  await deps?.closePools()
})

describe('switch-service keeps its promise to disbursement-service', () => {
  it('answers every interaction that the broker holds', async () => {
    const verifier = new Verifier({
      provider: 'switch-service',
      providerBaseUrl: `http://localhost:${PORT}`,

      pactBrokerUrl: brokerUrl,
      pactBrokerUsername: brokerUsername,
      pactBrokerPassword: brokerPassword,

      // Which contracts to verify. Not a file path: the broker decides.
      consumerVersionSelectors: [
        { mainBranch: true },
        { matchingBranch: true },
      ],
      enablePending: true,

      providerVersion: gitVersion(),
      providerVersionBranch: gitBranch(),
      // Without a published result the broker cannot answer can-i-deploy.
      publishVerificationResult,

      logLevel: 'warn',

      /**
       * Each state puts the service into a known condition. Each one clears
       * everything first, and each one is independent of the others.
       */
      stateHandlers: {
        'channels exist and RAIL-A is healthy': async () => {
          await resetAll()
          await seedChannels()
          // RAIL-A must win, and it must win clearly. Enough samples to leave
          // the cold start, a high success rate and a low latency.
          await writeWindow('RAIL-A', 96, 4, 200)
          await writeWindow('RAIL-B', 60, 40, 1_500)
          await writeWindow('RAIL-C', 55, 45, 1_800)
        },

        'all channels are open with equal health': async () => {
          await resetAll()
          await seedChannels()
          // No window at all. Every channel is cold, so every p95 is null and
          // every candidate carries coldStart true.
        },

        'RAIL-C breaker is open': async () => {
          await resetAll()
          await seedChannels()
          await writeWindow('RAIL-A', 90, 10, 250)
          await deps.redis.hset('breaker:RAIL-C', {
            state: 'OPEN',
            openedAt: String(deps.appClock.now()),
            probeSuccess: '0',
          })
        },

        'no channels are configured': async () => {
          await resetAll()
          // No channel at all. The service must answer 503 with the errorType
          // NO_ELIGIBLE_CHANNEL, exactly as the consumer expects.
        },
      },
    })

    await verifier.verifyProvider()
  }, 120_000)
})
