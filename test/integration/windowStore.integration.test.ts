import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import Redis from 'ioredis'
import { WindowStore } from '../../src/store/windowStore'
import { BreakerStore } from '../../src/store/breakerStore'
import { RedisProcessedStore } from '../../src/store/processedStore'
import { bucketIdAt, bucketKey } from '../../src/domain/window'

/**
 * The store against a real Redis.
 *
 * A unit test proves the maths. This test proves the plumbing: the keys, the
 * TTL, the cap on the samples and the pipeline. Those cannot be proven with a
 * fake, and they are where the mistakes hide.
 *
 * Redis database 3, so a run never touches the demo, the pact tests or the
 * end-to-end scenarios.
 */

const REDIS_URL = process.env.INTEGRATION_REDIS_URL ?? 'redis://localhost:6380/3'

const WINDOW_MS = 60_000
const BUCKET_MS = 5_000
const MAX_SAMPLES = 10

let redis: Redis
let windows: WindowStore

beforeAll(async () => {
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2 })
  await redis.ping()
  windows = new WindowStore(redis, WINDOW_MS, BUCKET_MS, MAX_SAMPLES)
})

afterAll(async () => {
  await redis.flushdb()
  await redis.quit()
})

beforeEach(async () => {
  await redis.flushdb()
})

const NOW = 1_800_000_000_000

describe('WindowStore against redis', () => {
  it('records a success and reads it back', async () => {
    await windows.record('RAIL-A', { success: true, latencyMs: 210 }, NOW)

    const stats = await windows.read('RAIL-A', NOW)
    expect(stats.success).toBe(1)
    expect(stats.failure).toBe(0)
    expect(stats.latencySamples).toEqual([210])
  })

  it('adds up the buckets across the window', async () => {
    // Three payouts, each in a different bucket.
    await windows.record('RAIL-A', { success: true, latencyMs: 100 }, NOW)
    await windows.record('RAIL-A', { success: true, latencyMs: 200 }, NOW + BUCKET_MS)
    await windows.record(
      'RAIL-A',
      { success: false, latencyMs: 300 },
      NOW + BUCKET_MS * 2,
    )

    const stats = await windows.read('RAIL-A', NOW + BUCKET_MS * 2)
    expect(stats.success).toBe(2)
    expect(stats.failure).toBe(1)
    expect(stats.latencySamples.sort((a, b) => a - b)).toEqual([100, 200, 300])
  })

  it('drops a payout out of the window once the window passes it', async () => {
    await windows.record('RAIL-A', { success: true, latencyMs: 100 }, NOW)

    const inside = await windows.read('RAIL-A', NOW + WINDOW_MS - BUCKET_MS)
    expect(inside.success).toBe(1)

    // One full window later the count is gone. This is what "sliding" means.
    const outside = await windows.read('RAIL-A', NOW + WINDOW_MS + BUCKET_MS)
    expect(outside.success).toBe(0)
    expect(outside.latencySamples).toEqual([])
  })

  it('puts a TTL on every key it writes', async () => {
    await windows.record('RAIL-A', { success: true, latencyMs: 100 }, NOW)
    const key = bucketKey('RAIL-A', bucketIdAt(NOW, BUCKET_MS))

    const ttl = await redis.ttl(key)
    // A key with no TTL lives forever, and Redis fills up in a week.
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual((WINDOW_MS * 2) / 1_000)

    const latTtl = await redis.ttl(`${key}:lat`)
    expect(latTtl).toBeGreaterThan(0)
  })

  it('caps the samples of one bucket', async () => {
    for (let i = 0; i < MAX_SAMPLES * 3; i += 1) {
      await windows.record('RAIL-A', { success: true, latencyMs: i + 1 }, NOW)
    }

    const stats = await windows.read('RAIL-A', NOW)
    // The counters keep every payout.
    expect(stats.success).toBe(MAX_SAMPLES * 3)
    // The samples do not. Without the cap, one busy channel fills the memory.
    expect(stats.latencySamples).toHaveLength(MAX_SAMPLES)
  })

  it('reads many channels in one round trip', async () => {
    await windows.record('RAIL-A', { success: true, latencyMs: 100 }, NOW)
    await windows.record('RAIL-B', { success: false, latencyMs: 900 }, NOW)
    await windows.record('RAIL-B', { success: false, latencyMs: 950 }, NOW)

    const all = await windows.readMany(['RAIL-A', 'RAIL-B', 'RAIL-C'], NOW)

    expect(all.get('RAIL-A')?.success).toBe(1)
    expect(all.get('RAIL-B')?.failure).toBe(2)
    // A channel with no data is not an error. It reads as zero.
    expect(all.get('RAIL-C')?.success).toBe(0)
    expect(all.get('RAIL-C')?.latencySamples).toEqual([])
  })

  it('does not mix one channel with another', async () => {
    await windows.record('RAIL-A', { success: true, latencyMs: 100 }, NOW)
    await windows.record('RAIL-B', { success: false, latencyMs: 100 }, NOW)

    const a = await windows.read('RAIL-A', NOW)
    const b = await windows.read('RAIL-B', NOW)
    expect(a.success).toBe(1)
    expect(a.failure).toBe(0)
    expect(b.success).toBe(0)
    expect(b.failure).toBe(1)
  })

  it('gives a series with one point for each bucket', async () => {
    await windows.record('RAIL-A', { success: true, latencyMs: 100 }, NOW)
    const buckets = await windows.readBuckets('RAIL-A', NOW)

    expect(buckets).toHaveLength(WINDOW_MS / BUCKET_MS)
    expect(buckets[buckets.length - 1]?.success).toBe(1)
    expect(buckets[0]?.success).toBe(0)
  })

  it('clears everything that it wrote', async () => {
    await windows.record('RAIL-A', { success: true, latencyMs: 100 }, NOW)
    await windows.record('RAIL-B', { success: true, latencyMs: 100 }, NOW)

    const removed = await windows.clear()
    expect(removed).toBeGreaterThan(0)
    expect((await windows.read('RAIL-A', NOW)).success).toBe(0)
  })
})

describe('BreakerStore against redis', () => {
  let breakers: BreakerStore

  beforeEach(() => {
    breakers = new BreakerStore(redis)
  })

  it('reads a channel that was never written as CLOSED', async () => {
    const snapshot = await breakers.read('RAIL-A')
    expect(snapshot.state).toBe('CLOSED')
    expect(snapshot.openedAt).toBe(0)
  })

  it('writes and reads a state back', async () => {
    await breakers.write('RAIL-A', {
      state: 'OPEN',
      openedAt: NOW,
      probeSuccess: 0,
    })
    const snapshot = await breakers.read('RAIL-A')
    expect(snapshot).toEqual({ state: 'OPEN', openedAt: NOW, probeSuccess: 0 })
  })

  it('reads a damaged value as CLOSED', async () => {
    // A blocked channel stops money. A value that cannot be read must never
    // block a channel.
    await redis.hset('breaker:RAIL-A', { state: 'MELTING', openedAt: 'soon' })
    const snapshot = await breakers.read('RAIL-A')
    expect(snapshot.state).toBe('CLOSED')
  })

  it('gives the probe slot to one caller only', async () => {
    const results = await Promise.all([
      breakers.takeProbeSlot('RAIL-A', 5_000),
      breakers.takeProbeSlot('RAIL-A', 5_000),
      breakers.takeProbeSlot('RAIL-A', 5_000),
      breakers.takeProbeSlot('RAIL-A', 5_000),
    ])
    // Without this lock a burst of payouts all pour into a rail that is still
    // broken.
    expect(results.filter(Boolean)).toHaveLength(1)
  })

  it('gives the slot back when it is released', async () => {
    expect(await breakers.takeProbeSlot('RAIL-A', 5_000)).toBe(true)
    expect(await breakers.takeProbeSlot('RAIL-A', 5_000)).toBe(false)
    await breakers.releaseProbeSlot('RAIL-A')
    expect(await breakers.takeProbeSlot('RAIL-A', 5_000)).toBe(true)
  })

  it('lets the slot go by itself when nobody releases it', async () => {
    // The TTL is the safety net. A payout that never reports back must not
    // hold the slot forever.
    expect(await breakers.takeProbeSlot('RAIL-A', 100)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(await breakers.takeProbeSlot('RAIL-A', 100)).toBe(true)
  })
})

describe('RedisProcessedStore', () => {
  it('claims an event once', async () => {
    const processed = new RedisProcessedStore(redis, 60)
    expect(await processed.claim('evt-1')).toBe(true)
    expect(await processed.claim('evt-1')).toBe(false)
    expect(await processed.claim('evt-2')).toBe(true)
  })

  it('lets only one of many callers claim the same event', async () => {
    const processed = new RedisProcessedStore(redis, 60)
    const results = await Promise.all(
      Array.from({ length: 6 }, () => processed.claim('evt-race')),
    )
    expect(results.filter(Boolean)).toHaveLength(1)
  })
})
