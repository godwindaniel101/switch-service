import { config } from '../config'
import { db } from '../db/pool'
import { redisHealthy } from '../redis/client'

/**
 * The readiness rules of this service.
 *
 * Redis holds derived data. A routing decision still happens when Redis is
 * down, in degraded mode, so Redis does NOT make this service unready. Marking
 * it unready would take a working service out of the load balancer during a
 * metrics outage and stop the money for no reason.
 */

export interface ReadinessReport {
  ready: boolean
  dependencies: {
    postgres: 'up' | 'down'
    redis: 'up' | 'down'
    migrations: 'complete' | 'pending'
    outcomeConsumer: 'running' | 'stopped'
  }
}

export class HealthService {
  private migrationsComplete = false
  private consumerRunning = false

  setMigrationsComplete(value: boolean): void {
    this.migrationsComplete = value
  }

  setConsumerRunning(value: boolean): void {
    this.consumerRunning = value
  }

  get isReady(): boolean {
    return this.migrationsComplete
  }

  liveness(): { status: 'alive'; uptimeSeconds: number } {
    return { status: 'alive', uptimeSeconds: Math.round(process.uptime()) }
  }

  async readiness(): Promise<ReadinessReport> {
    const postgres = await withTimeout(
      db
        .query('SELECT 1')
        .then(() => true)
        .catch(() => false),
      1_000,
      false,
    )
    const redis = await withTimeout(redisHealthy(900), 1_000, false)

    return {
      ready: postgres && this.migrationsComplete,
      dependencies: {
        postgres: postgres ? 'up' : 'down',
        redis: redis ? 'up' : 'down',
        migrations: this.migrationsComplete ? 'complete' : 'pending',
        outcomeConsumer: this.consumerRunning ? 'running' : 'stopped',
      },
    }
  }

  /** The routing settings, so an operator can see what is in force. */
  routingSummary(): { windowMs: number; bucketMs: number; explorationRate: number } {
    return {
      windowMs: config.routing.windowMs,
      bucketMs: config.routing.bucketMs,
      explorationRate: config.routing.explorationRate,
    }
  }
}

/** A check that hangs is worse than a check that fails. */
async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
