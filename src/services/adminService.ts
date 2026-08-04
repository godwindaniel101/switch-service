import { config } from '../config'
import { logger } from '../lib/logger'
import { NotFoundError } from '../lib/errors'
import type { OffsetClock } from '../lib/clock'
import type Redis from 'ioredis'
import type { WindowStore } from '../store/windowStore'
import type { BreakerStore } from '../store/breakerStore'
import { ensureConsumerGroup } from '../redis/consumerGroup'
import * as channelRepository from '../repositories/channelRepository'
import * as decisionRepository from '../repositories/decisionRepository'
import type { Channel } from '../domain/types'

/**
 * The actions that only a test needs: reset, seed, move the clock, dump.
 *
 * THIS CLASS EXISTS BECAUSE OF A DEFECT. The internal route used to drive six
 * stores from one HTTP handler, and the ORDER of those calls is load bearing.
 * An order of work is a business rule, and a business rule in a route handler
 * cannot be tested without HTTP.
 */

const DEFAULT_SEED = [
  { id: 'RAIL-A', name: 'Alpha Bank Rail', cost: 1.2, enabled: true },
  { id: 'RAIL-B', name: 'Beta Payments Rail', cost: 1.0, enabled: true },
  { id: 'RAIL-C', name: 'Gamma Switch Rail', cost: 0.8, enabled: true },
]

export interface SeedChannelInput {
  id: string
  name: string
  cost: number
  enabled?: boolean
}

export class AdminService {
  constructor(
    private readonly windows: WindowStore,
    private readonly breakers: BreakerStore,
    private readonly redis: Redis,
    private readonly clock: OffsetClock,
  ) {}

  /** Guards every action in this class. */
  private assertNotProduction(): void {
    if (config.NODE_ENV === 'production') throw new NotFoundError('no route')
  }

  /**
   * The clock endpoint exists only in test mode.
   *
   * This is why the routing code has NO test branch inside it: the clock is
   * injected at the edge, and the domain never asks what mode it runs in.
   */
  advanceClock(ms: number): { offsetMs: number; now: string } {
    if (!config.isTest) throw new NotFoundError('no route')
    const offset = this.clock.advance(ms)
    logger.info({ advanceMs: ms, offset }, 'test clock moved')
    return { offsetMs: offset, now: this.clock.isoNow() }
  }

  clockState(): { offsetMs: number; now: string } {
    return { offsetMs: this.clock.offset, now: this.clock.isoNow() }
  }

  /**
   * Puts the service back to a known state.
   *
   * THE ORDER IS THE POINT, and every step has a reason:
   *   1. Reset the clock, so the window keys line up with real time again.
   *   2. Clear the window keys.
   *   3. Clear the breaker state and the probe locks.
   *   4. Empty the decision log.
   *   5. Remove EVERY channel, including one an earlier test added. A leftover
   *      channel makes the next test route to it, and the failure then points
   *      at the wrong place.
   *   6. Clear the stream, then MAKE THE CONSUMER GROUP AGAIN. Deleting the
   *      stream key destroys the group with it, and the consumer would read
   *      NOGROUP forever while the health check still said "running".
   *
   * It does NOT drop the database. A drop forces the migrations again and adds
   * many seconds to every test.
   */
  async reset(): Promise<{ reset: true; removedWindowKeys: number }> {
    this.assertNotProduction()

    this.clock.reset()
    const removedWindowKeys = await this.windows.clear()

    const channels = await channelRepository.listChannels()
    await this.breakers.reset(channels.map((c) => c.id))
    await decisionRepository.truncateDecisions()
    await channelRepository.deleteAllChannels()
    channelRepository.clearChannelCache()

    await this.redis.del(config.OUTCOME_STREAM).catch(() => 0)
    await this.redis.del(config.DEAD_LETTER_STREAM).catch(() => 0)
    await ensureConsumerGroup(this.redis).catch((error: unknown) => {
      logger.error({ err: error }, 'could not make the consumer group again')
      throw error
    })
    await this.deleteByPattern('processed:*')
    await this.deleteByPattern('probe:*')

    return { reset: true, removedWindowKeys }
  }

  async seed(channels?: SeedChannelInput[]): Promise<Channel[]> {
    this.assertNotProduction()
    const wanted = channels && channels.length > 0 ? channels : DEFAULT_SEED
    const saved: Channel[] = []
    for (const channel of wanted) {
      saved.push(await channelRepository.upsertChannel(channel))
    }
    return saved
  }

  /** The state that a failing scenario prints. */
  async dump(): Promise<Record<string, unknown>> {
    const now = this.clock.now()
    const channels = await channelRepository.listChannels()
    const ids = channels.map((c) => c.id)
    const stats = await this.windows.readMany(ids, now)
    const breakerStates = await this.breakers.readMany(ids)

    const streamLength = await this.redis.xlen(config.OUTCOME_STREAM).catch(() => -1)
    const groups = (await this.redis
      .xinfo('GROUPS', config.OUTCOME_STREAM)
      .catch(() => [])) as unknown[]

    return {
      now: new Date(now).toISOString(),
      clockOffsetMs: this.clock.offset,
      window: ids.map((id) => ({
        channelId: id,
        success: stats.get(id)?.success ?? 0,
        failure: stats.get(id)?.failure ?? 0,
        sampleCount: stats.get(id)?.latencySamples.length ?? 0,
        breaker: breakerStates.get(id),
      })),
      stream: {
        name: config.OUTCOME_STREAM,
        length: streamLength,
        // A pending count that grows means the consumer stopped. That is the
        // most common cause of a stuck scenario.
        groups,
      },
      recentDecisions: await decisionRepository.listRecentDecisions(20),
    }
  }

  private async deleteByPattern(pattern: string): Promise<number> {
    let cursor = '0'
    let removed = 0
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500)
      cursor = next
      if (keys.length > 0) removed += await this.redis.del(...keys)
    } while (cursor !== '0')
    return removed
  }
}
