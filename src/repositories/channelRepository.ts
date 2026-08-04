import { db, dbRead } from '../db/pool'
import type { Channel } from '../domain/types'

/**
 * The channel registry.
 *
 * A routing decision sits in the money path, so it must not wait for a
 * database round trip. The list changes very rarely, so a short cache is the
 * right answer. Five seconds is short enough that an operator sees a change
 * at once, and long enough that a burst of payouts costs one query.
 */

const CACHE_TTL_MS = 5_000
const DEFAULT_CORRIDOR = 'NGN_BANK'
const CHANNEL_COLUMNS = 'id, name, cost, corridor, enabled'

interface Row {
  id: string
  name: string
  cost: string
  corridor: string
  enabled: boolean
}

let cache: { at: number; channels: Channel[] } | null = null

function toChannel(row: Row): Channel {
  return {
    id: row.id,
    name: row.name,
    // NUMERIC arrives as a string. Number() here is safe: a cost is small.
    cost: Number(row.cost),
    enabled: row.enabled,
  }
}

export async function listChannels(corridor = DEFAULT_CORRIDOR): Promise<Channel[]> {
  const result = await dbRead.query<Row>(
    `SELECT ${CHANNEL_COLUMNS}
       FROM channels
      WHERE corridor = $1
      ORDER BY id`,
    [corridor],
  )
  return result.rows.map(toChannel)
}

/** The cached read that the routing path uses. */
export async function listChannelsCached(
  now: number,
  corridor = DEFAULT_CORRIDOR,
): Promise<Channel[]> {
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.channels
  const channels = await listChannels(corridor)
  cache = { at: now, channels }
  return channels
}

export function clearChannelCache(): void {
  cache = null
}

export async function setEnabled(id: string, enabled: boolean): Promise<Channel | null> {
  const result = await db.query<Row>(
    `UPDATE channels SET enabled = $2, updated_at = now()
      WHERE id = $1
      RETURNING ${CHANNEL_COLUMNS}`,
    [id, enabled],
  )
  clearChannelCache()
  const row = result.rows[0]
  return row ? toChannel(row) : null
}

export interface UpsertChannelInput {
  id: string
  name: string
  cost: number
  corridor?: string
  enabled?: boolean
}

/** Used by the seed step of the harness and by a provider state. */
export async function upsertChannel(input: UpsertChannelInput): Promise<Channel> {
  const result = await db.query<Row>(
    `INSERT INTO channels (id, name, cost, corridor, enabled)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE
       SET name = EXCLUDED.name, cost = EXCLUDED.cost,
           corridor = EXCLUDED.corridor, enabled = EXCLUDED.enabled,
           updated_at = now()
     RETURNING ${CHANNEL_COLUMNS}`,
    [
      input.id,
      input.name,
      input.cost,
      input.corridor ?? DEFAULT_CORRIDOR,
      input.enabled ?? true,
    ],
  )
  clearChannelCache()
  return toChannel(result.rows[0] as Row)
}

/** Used by a provider state and by the harness. Never in production code. */
export async function deleteAllChannels(): Promise<void> {
  await db.query('DELETE FROM channels')
  clearChannelCache()
}
