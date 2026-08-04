import type Redis from 'ioredis'
import { breakerKey, probeLockKey } from '../domain/window'
import { closedBreaker, type BreakerSnapshot } from '../domain/types'

/**
 * The breaker state in Redis.
 *
 * The state machine itself is pure and lives in `domain/breaker.ts`. This
 * layer only reads and writes.
 */
export class BreakerStore {
  constructor(private readonly redis: Redis) {}

  async read(channelId: string): Promise<BreakerSnapshot> {
    const raw = await this.redis.hgetall(breakerKey(channelId))
    return parseSnapshot(raw)
  }

  async readMany(
    channelIds: readonly string[],
  ): Promise<Map<string, BreakerSnapshot>> {
    const result = new Map<string, BreakerSnapshot>()
    if (channelIds.length === 0) return result

    const pipeline = this.redis.multi()
    for (const id of channelIds) pipeline.hgetall(breakerKey(id))
    const replies = await pipeline.exec()

    channelIds.forEach((id, index) => {
      const raw = replies?.[index]?.[1] as Record<string, string> | undefined
      result.set(id, parseSnapshot(raw ?? {}))
    })
    return result
  }

  async write(channelId: string, snapshot: BreakerSnapshot): Promise<void> {
    await this.redis.hset(breakerKey(channelId), {
      state: snapshot.state,
      openedAt: String(snapshot.openedAt),
      probeSuccess: String(snapshot.probeSuccess),
    })
  }

  /**
   * Takes the single probe slot of a HALF_OPEN breaker.
   *
   * `SET NX` with a TTL is the whole lock. Without it, a burst of 50 payouts
   * all arrive while the breaker is HALF_OPEN and all 50 go into a rail that
   * is still broken.
   *
   * The TTL releases the slot if the payout never reports back.
   */
  async takeProbeSlot(channelId: string, ttlMs: number): Promise<boolean> {
    const result = await this.redis.set(
      probeLockKey(channelId),
      '1',
      'PX',
      ttlMs,
      'NX',
    )
    return result === 'OK'
  }

  async releaseProbeSlot(channelId: string): Promise<void> {
    await this.redis.del(probeLockKey(channelId))
  }

  async reset(channelIds: readonly string[]): Promise<void> {
    if (channelIds.length === 0) return
    const pipeline = this.redis.multi()
    for (const id of channelIds) {
      pipeline.del(breakerKey(id))
      pipeline.del(probeLockKey(id))
    }
    await pipeline.exec()
  }
}

function parseSnapshot(raw: Record<string, string>): BreakerSnapshot {
  const state = raw.state
  if (state !== 'OPEN' && state !== 'HALF_OPEN') {
    // Anything unknown reads as CLOSED. A damaged value must not block a
    // channel, because a blocked channel stops money.
    return closedBreaker()
  }
  return {
    state,
    openedAt: toNumber(raw.openedAt),
    probeSuccess: toNumber(raw.probeSuccess),
  }
}

function toNumber(raw: string | undefined): number {
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : 0
}
