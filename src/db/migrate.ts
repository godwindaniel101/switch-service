import fs from 'node:fs'
import path from 'node:path'
import { db } from './pool'
import { logger } from '../lib/logger'

/**
 * Runs the pending migrations before the server listens.
 *
 * An advisory lock stops two instances from running the same migration at the
 * same time. Without the lock, two containers that start together both try to
 * create the same table.
 */

const ADVISORY_LOCK_KEY = 4711
const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'migrations')

export async function runMigrations(): Promise<string[]> {
  const client = await db.connect()
  const applied: string[] = []
  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY])

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)

    const done = new Set(
      (
        await client.query<{ name: string }>('SELECT name FROM schema_migrations')
      ).rows.map((r) => r.name),
    )

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort()

    for (const file of files) {
      if (done.has(file)) continue
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
      logger.info({ file }, 'applying migration')
      // Each migration runs in its own transaction. One bad file does not
      // undo the files before it.
      try {
        await client.query('BEGIN')
        await client.query(sql)
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file])
        await client.query('COMMIT')
        applied.push(file)
      } catch (error) {
        await client.query('ROLLBACK')
        throw new Error(`migration ${file} failed: ${(error as Error).message}`, {
          cause: error,
        })
      }
    }

    if (applied.length === 0) logger.info('no pending migration')
    return applied
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY])
    client.release()
  }
}
