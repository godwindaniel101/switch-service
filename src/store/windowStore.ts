import type Redis from 'ioredis'
import { config } from '../config'
import {
  bucketIdAt,
  bucketKey,
  bucketTtlSeconds,
  latencyKey,
  windowBucketIds,
} from '../domain/window'
import { emptyStats, type ChannelStats } from '../domain/types'

/**
 * The window counters in Redis.
 *
 * This layer reads and writes. It holds no maths. Every function takes `now`
 * from the caller, so a test can move time without touching a clock.
 */

export class WindowStore {
  constructor(
    private readonly redis: Redis,
    private readonly windowMs: number = config.routing.windowMs,
    private readonly bucketMs: number = config.routing.bucketMs,
    private readonly maxSamplesPerBucket: number = config.routing.maxSamplesPerBucket,
  ) {}

  /**
   * Adds one outcome to the bucket that holds `now`.
   *
   * The TTL is set on every write. A key that never gets a TTL lives forever,
   * and Redis fills up in a week.
   */
  async record(
    channelId: string,
    outcome: { success: boolean; latencyMs: number },
    now: number,
  ): Promise<void> {
    const id = bucketIdAt(now, this.bucketMs)
    const counters = bucketKey(channelId, id)
    const samples = latencyKey(channelId, id)
    const ttl = bucketTtlSeconds(this.windowMs)

    const pipeline = this.redis.multi()
    pipeline.hincrby(counters, outcome.success ? 'success' : 'failure', 1)
    pipeline.hincrby(counters, 'latSum', Math.round(outcome.latencyMs))
    pipeline.expire(counters, ttl)
    pipeline.lpush(samples, String(Math.round(outcome.latencyMs)))
    // Cap the list. Without a cap, one busy channel fills the memory and the
    // p95 sort becomes the slowest part of a routing decision.
    pipeline.ltrim(samples, 0, this.maxSamplesPerBucket - 1)
    pipeline.expire(samples, ttl)
    await pipeline.exec()
  }

  /** Reads the window of one channel. A missing bucket holds zero. */
  async read(channelId: string, now: number): Promise<ChannelStats> {
    const all = await this.readMany([channelId], now)
    return all.get(channelId) ?? emptyStats(channelId)
  }

  /** Reads the window of every channel in one round trip. */
  async readMany(
    channelIds: readonly string[],
    now: number,
  ): Promise<Map<string, ChannelStats>> {
    const result = new Map<string, ChannelStats>()
    if (channelIds.length === 0) return result

    const ids = windowBucketIds(now, this.windowMs, this.bucketMs)
    const pipeline = this.redis.multi()
    for (const channelId of channelIds) {
      for (const id of ids) {
        pipeline.hmget(bucketKey(channelId, id), 'success', 'failure')
        pipeline.lrange(latencyKey(channelId, id), 0, -1)
      }
    }
    const replies = await pipeline.exec()

    channelIds.forEach((channelId, channelIndex) => {
      const stats = emptyStats(channelId)
      const start = channelIndex * ids.length
      for (let bucketIndex = 0; bucketIndex < ids.length; bucketIndex += 1) {
        const bucket = readBucketReply(replies, start + bucketIndex)
        stats.success += bucket.success
        stats.failure += bucket.failure
        stats.latencySamples.push(...bucket.samples)
      }
      result.set(channelId, stats)
    })

    return result
  }

  /**
   * The buckets of one channel, oldest first, with the time of each bucket.
   *
   * The console draws this as a line. The routing decision does not use it:
   * a decision needs one aggregate, not a series.
   */
  async readBuckets(
    channelId: string,
    now: number,
  ): Promise<
    Array<{ bucketId: number; startMs: number; success: number; failure: number; samples: number[] }>
  > {
    const ids = windowBucketIds(now, this.windowMs, this.bucketMs)
    const pipeline = this.redis.multi()
    for (const id of ids) {
      pipeline.hmget(bucketKey(channelId, id), 'success', 'failure')
      pipeline.lrange(latencyKey(channelId, id), 0, -1)
    }
    const replies = await pipeline.exec()

    return ids.map((id, index) => ({
      bucketId: id,
      startMs: id * this.bucketMs,
      ...readBucketReply(replies, index),
    }))
  }

  /** Used by the harness between scenarios. */
  async clear(): Promise<number> {
    let removed = 0
    let cursor = '0'
    do {
      const [next, keys] = await this.redis.scan(
        cursor,
        'MATCH',
        'sw:*',
        'COUNT',
        500,
      )
      cursor = next
      if (keys.length > 0) removed += await this.redis.del(...keys)
    } while (cursor !== '0')
    return removed
  }
}

/** What one `exec()` gives back: a pair of error and result per command. */
type PipelineReplies = readonly (readonly [Error | null, unknown])[] | null

/**
 * Reads one bucket out of the pipeline replies. Each bucket takes two
 * commands, the counters then the latency list, so bucket `index` sits at
 * `index * 2`. Every caller lays the pipeline out that way, so the offset
 * rule lives here once.
 *
 * The filter drops a value that is not finite or is below zero. A corrupt
 * negative latency would pull the p95 down and hide a slow channel.
 */
function readBucketReply(
  replies: PipelineReplies,
  index: number,
): { success: number; failure: number; samples: number[] } {
  const counters = replies?.[index * 2]?.[1] as
    | [string | null, string | null]
    | undefined
  const raw = (replies?.[index * 2 + 1]?.[1] as string[] | undefined) ?? []
  return {
    success: toCount(counters?.[0]),
    failure: toCount(counters?.[1]),
    samples: raw
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value >= 0),
  }
}

function toCount(raw: string | null | undefined): number {
  if (!raw) return 0
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : 0
}
