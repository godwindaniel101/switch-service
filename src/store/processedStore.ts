import type Redis from 'ioredis'
import { processedKey } from '../domain/window'

/**
 * Remembers which events were already applied.
 *
 * The same event can arrive twice. The producer marks a row as sent only
 * after Redis confirms the write, so a crash between the two can send a row a
 * second time. That is the correct trade: a repeated event is safe, a lost
 * event is not.
 *
 * Without this guard, one replayed failure counts twice and it opens a
 * breaker that should have stayed shut.
 */
export interface ProcessedStore {
  /** True when this call claimed the event. False when it is a repeat. */
  claim(eventId: string): Promise<boolean>
}

export class RedisProcessedStore implements ProcessedStore {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number,
  ) {}

  async claim(eventId: string): Promise<boolean> {
    // NX makes this atomic. Two consumers that read the same event at the
    // same time cannot both win.
    const result = await this.redis.set(
      processedKey(eventId),
      '1',
      'EX',
      this.ttlSeconds,
      'NX',
    )
    return result === 'OK'
  }
}

/** An in-memory version, for a unit test and for the message pact. */
export class MemoryProcessedStore implements ProcessedStore {
  private readonly seen = new Set<string>()

  async claim(eventId: string): Promise<boolean> {
    if (this.seen.has(eventId)) return false
    this.seen.add(eventId)
    return true
  }
}
