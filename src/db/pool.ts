import { Pool, type PoolClient } from 'pg'
import { config } from '../config'
import { logger } from '../lib/logger'
import { sleep } from '../lib/sleep'
import { DatabaseUnavailableError } from '../lib/errors'

/**
 * Two pools from the first day.
 *
 *   db      the primary. Every write, and every read that follows a write.
 *   dbRead  the replica. Reports and lists.
 *
 * In local work both point at the same database. In production they do not.
 * The split must exist in the code from the start, because a later split
 * touches every query.
 */

function makePool(connectionString: string, role: 'write' | 'read'): Pool {
  const pool = new Pool({
    connectionString,
    max: config.DATABASE_POOL_MAX,
    idleTimeoutMillis: 30_000,
    // Fail fast. A payout must not hang while it waits for a connection.
    connectionTimeoutMillis: 5_000,
    application_name: `switch-service:${role}`,
  })

  // An idle client can fail without any query in flight. Without this handler
  // the process exits.
  pool.on('error', (error) => {
    logger.error({ err: error, role }, 'idle postgres client failed')
  })

  return pool
}

export const db = makePool(config.DATABASE_URL, 'write')
export const dbRead = makePool(config.databaseReadUrl, 'read')

/**
 * Retries the first connection with a backoff. At start the database may not
 * be ready. Inside a request there is no retry: the request fails fast.
 */
export async function waitForDatabase(maxAttempts = 6): Promise<void> {
  const delays = [250, 500, 1_000, 2_000, 4_000, 8_000]
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await db.query('SELECT 1')
      logger.info({ attempt }, 'postgres is ready')
      return
    } catch (error) {
      if (attempt === maxAttempts) {
        throw new DatabaseUnavailableError(
          `postgres did not answer after ${maxAttempts} attempts`,
          {},
          { cause: error },
        )
      }
      const delay = delays[attempt - 1] ?? 8_000
      logger.warn({ attempt, delay }, 'postgres is not ready, retrying')
      await sleep(delay)
    }
  }
}

/**
 * Runs a function inside one transaction, with a statement timeout.
 *
 * A query with no timeout can hold a connection forever. Ten of them empty
 * the pool and the service stops.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `SET LOCAL statement_timeout = ${config.DATABASE_STATEMENT_TIMEOUT_MS}`,
    )
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch (rollbackError) {
      logger.error({ err: rollbackError }, 'rollback failed')
    }
    throw error
  } finally {
    client.release()
  }
}

export async function closePools(): Promise<void> {
  await Promise.allSettled([db.end(), dbRead.end()])
}
