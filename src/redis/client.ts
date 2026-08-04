import Redis from 'ioredis'
import { config } from '../config'
import { logger } from '../lib/logger'

/**
 * TWO clients, and the reason matters.
 *
 *   redis          normal commands: counters, breaker state, locks
 *   redisBlocking  XREADGROUP with BLOCK, and nothing else
 *
 * A blocking read holds the connection for as long as it blocks. With one
 * shared client, every counter read would wait behind the blocking read, and
 * a routing decision would take seconds.
 */

function makeClient(role: 'command' | 'blocking'): Redis {
  const client = new Redis(config.REDIS_URL, {
    // A small number, not the default of 20. A retry that never stops hides
    // an outage instead of reporting it.
    maxRetriesPerRequest: role === 'blocking' ? null : 2,
    enableReadyCheck: true,
    connectTimeout: 3_000,
    retryStrategy: (times) => Math.min(times * 200, 5_000),
    connectionName: `switch-service-${role}`,
  })

  client.on('error', (error: Error) => {
    // Log and continue. Redis holds derived data only. A routing decision
    // still happens when Redis is down; it is simply less informed.
    logger.warn({ err: error, role }, 'redis connection problem')
  })

  return client
}

export const redis = makeClient('command')
export const redisBlocking = makeClient('blocking')

export async function redisHealthy(timeoutMs = 1_000): Promise<boolean> {
  try {
    const answer = await Promise.race([
      redis.ping(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('ping timeout')), timeoutMs),
      ),
    ])
    return answer === 'PONG'
  } catch {
    return false
  }
}

/**
 * Runs a Redis read with a hard budget.
 *
 * The money path must never wait for the metrics path. If Redis is slow, the
 * router uses the fallback value and marks the decision.
 */
export async function withBudget<T>(
  operation: () => Promise<T>,
  budgetMs: number,
  fallback: T,
): Promise<{ value: T; timedOut: boolean }> {
  let timer: NodeJS.Timeout | undefined
  try {
    const timeout = new Promise<{ value: T; timedOut: true }>((resolve) => {
      timer = setTimeout(() => resolve({ value: fallback, timedOut: true }), budgetMs)
    })
    const work = operation().then((value) => ({ value, timedOut: false as const }))
    return await Promise.race([work, timeout])
  } catch (error) {
    logger.warn({ err: error }, 'redis read failed, using the fallback')
    return { value: fallback, timedOut: true }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function closeRedis(): Promise<void> {
  for (const client of [redis, redisBlocking]) {
    try {
      await client.quit()
    } catch {
      client.disconnect()
    }
  }
}
