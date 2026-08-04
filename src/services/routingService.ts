import { randomUUID } from 'node:crypto'
import { config } from '../config'
import { logger } from '../lib/logger'
import { events } from '../lib/sse'
import { withBudget } from '../redis/client'
import type { Clock, Rng } from '../lib/ports'
import { buildCandidates } from '../domain/scoring'
import { evaluateBreaker } from '../domain/breaker'
import { selectChannel, NoEligibleChannelError as DomainNoEligible } from '../domain/selection'
import {
  emptyStats,
  closedBreaker,
  type Candidate,
  type Channel,
  type ChannelStats,
  type BreakerSnapshot,
  type RoutingDecision,
} from '../domain/types'
import { NoEligibleChannelError } from '../lib/errors'
import type { WindowStore } from '../store/windowStore'
import type { BreakerStore } from '../store/breakerStore'
import * as channelRepository from '../repositories/channelRepository'
import * as decisionRepository from '../repositories/decisionRepository'

/**
 * The routing decision.
 *
 * The maths is pure and lives in `domain/`. This service reads the numbers,
 * calls the pure functions, and writes the result.
 *
 * Rules that this service must never break:
 *   - It never routes to a channel whose breaker is OPEN.
 *   - It never fails a payout because the metrics are missing. With no
 *     metrics it picks the first eligible channel and marks the reason.
 *   - It never returns NaN as a score.
 */

export interface RouteRequestInput {
  transactionId: string
  amountMinor: number
  currency: string
  corridor: string
  bankCode: string
  requestedAt: string
  /**
   * The channels the CALLER can reach. Absent means no limit, which is what an
   * older caller sends.
   */
  supportedChannels?: string[]
}

/** How long a probe slot is held before it releases by itself. */
const PROBE_SLOT_TTL_MS = 10_000

export class RoutingService {
  constructor(
    private readonly windows: WindowStore,
    private readonly breakers: BreakerStore,
    private readonly clock: Clock,
    private readonly rng: Rng,
  ) {}

  async route(request: RouteRequestInput): Promise<RoutingDecision> {
    const now = this.clock.now()
    const all = await channelRepository.listChannelsCached(now, request.corridor)

    // Keep only what the CALLER can reach.
    //
    // This is the structural guarantee: after this line it is impossible for
    // this service to answer with a channel that the caller has no rail for.
    // The caller still checks the answer, but that check is now defence in
    // depth and not the mechanism.
    //
    // Absent means no limit. An older caller that sends nothing keeps working.
    const channels = request.supportedChannels
      ? all.filter((channel) => request.supportedChannels?.includes(channel.id))
      : all

    if (channels.length === 0) {
      // Say WHICH case this is. "No channel at all" and "no channel that you
      // can reach" look the same to a caller and need different repairs.
      const reason =
        all.length === 0
          ? 'no channel is configured for this corridor'
          : 'no channel is eligible for this corridor'
      logger.warn(
        {
          corridor: request.corridor,
          configured: all.map((c) => c.id),
          supportedByCaller: request.supportedChannels ?? 'not stated',
        },
        all.length === 0
          ? 'no channel is configured'
          : 'no configured channel is one the caller can reach',
      )
      throw new NoEligibleChannelError(reason, { corridor: request.corridor })
    }

    const ids = channels.map((c) => c.id)

    // The metrics read has a hard budget. If Redis is slow, the payout still
    // goes out. A routing opinion is an improvement, not a requirement.
    type Metrics = {
      stats: Map<string, ChannelStats> | null
      breakers: Map<string, BreakerSnapshot> | null
    }

    const metrics = await withBudget<Metrics>(
      async () => ({
        stats: await this.windows.readMany(ids, now),
        breakers: await this.breakers.readMany(ids),
      }),
      config.METRICS_TIMEOUT_MS,
      { stats: null, breakers: null },
    )

    if (metrics.timedOut || !metrics.value.stats || !metrics.value.breakers) {
      return this.degradedDecision(channels, request, now)
    }

    const stats = metrics.value.stats
    const breakers = await this.refreshBreakers(
      ids,
      metrics.value.breakers,
      stats,
      now,
    )

    let candidates = buildCandidates(channels, stats, breakers, config.routing)
    let selection = this.select(candidates)

    // A HALF_OPEN channel gets ONE payout at a time. Without the lock, a
    // burst of 50 payouts all arrive while the breaker is half open and all
    // 50 go into a rail that is still broken.
    const chosen = candidates.find((c) => c.channelId === selection.channelId)
    if (chosen?.breakerState === 'HALF_OPEN') {
      const gotSlot = await this.breakers.takeProbeSlot(
        chosen.channelId,
        PROBE_SLOT_TTL_MS,
      )
      if (!gotSlot) {
        candidates = candidates.map((candidate) =>
          candidate.channelId === chosen.channelId
            ? { ...candidate, eligible: false, ineligibleReason: 'probe-in-flight' }
            : candidate,
        )
        selection = this.select(candidates)
      }
    }

    const decision: RoutingDecision = {
      decisionId: `dec_${randomUUID()}`,
      channelId: selection.channelId,
      strategy: selection.strategy,
      windowMs: config.routing.windowMs,
      evaluatedAt: this.clock.isoNow(),
      candidates,
    }

    await this.persist(decision, request.transactionId)
    events.publish('routing.decision', decision)
    return decision
  }

  /** Turns the domain error into the wire error that the pact promises. */
  private select(candidates: readonly Candidate[]): {
    channelId: string
    strategy: RoutingDecision['strategy']
  } {
    try {
      return selectChannel(candidates, config.routing, this.rng)
    } catch (error) {
      if (error instanceof DomainNoEligible) {
        throw new NoEligibleChannelError('no channel is eligible for this corridor', {
          reasons: error.reasons,
        })
      }
      throw error
    }
  }

  /**
   * Moves each breaker with the fresh window numbers before the decision.
   *
   * This is where an OPEN breaker becomes HALF_OPEN after its time. Without
   * this step, a breaker would only reopen when a new outcome arrives, and a
   * channel with no traffic would stay blocked forever.
   */
  private async refreshBreakers(
    ids: readonly string[],
    current: Map<string, BreakerSnapshot>,
    stats: Map<string, ChannelStats>,
    now: number,
  ): Promise<Map<string, BreakerSnapshot>> {
    const next = new Map<string, BreakerSnapshot>()
    for (const id of ids) {
      const before = current.get(id) ?? closedBreaker()
      const after = evaluateBreaker(
        before,
        stats.get(id) ?? emptyStats(id),
        config.routing,
        now,
      )
      next.set(id, after)
      if (after.state !== before.state || after.openedAt !== before.openedAt) {
        try {
          await this.breakers.write(id, after)
          logger.info(
            { channelId: id, from: before.state, to: after.state },
            'breaker state changed',
          )
          events.publish('breaker.changed', {
            channelId: id,
            from: before.state,
            to: after.state,
            at: this.clock.isoNow(),
          })
        } catch (error) {
          // The decision still stands. The state is derived data, and a lost
          // write costs one cycle.
          logger.warn({ err: error, channelId: id }, 'breaker write failed')
        }
      }
    }
    return next
  }

  /**
   * The answer when the metrics are not available.
   *
   * Every channel looks unknown, so the first enabled channel wins. The
   * strategy says "degraded", and an operator can see why the choice looks
   * poor.
   */
  private degradedDecision(
    channels: readonly Channel[],
    request: RouteRequestInput,
    now: number,
  ): RoutingDecision {
    logger.warn(
      { corridor: request.corridor },
      'metrics are not available, routing in degraded mode',
    )

    const candidates: Candidate[] = channels.map((channel, index) => ({
      channelId: channel.id,
      rank: index + 1,
      score: 0,
      successRate: 0,
      p95Ms: null,
      costScore: 0,
      breakerState: 'CLOSED',
      samples: 0,
      coldStart: true,
      eligible: channel.enabled,
      ineligibleReason: channel.enabled ? null : 'channel-disabled',
    }))

    const first = candidates.find((c) => c.eligible)
    if (!first) {
      throw new NoEligibleChannelError('every channel is disabled', {
        corridor: request.corridor,
      })
    }

    const decision: RoutingDecision = {
      decisionId: `dec_${randomUUID()}`,
      channelId: first.channelId,
      strategy: 'degraded',
      windowMs: config.routing.windowMs,
      evaluatedAt: new Date(now).toISOString(),
      candidates,
    }
    events.publish('routing.decision', decision)
    void this.persist(decision, request.transactionId)
    return decision
  }

  /**
   * Writes the decision log. A failure here never fails the payout: the log
   * is for a person, and the payout is for a customer.
   */
  private async persist(
    decision: RoutingDecision,
    transactionId: string,
  ): Promise<void> {
    try {
      await decisionRepository.insertDecision(decision, transactionId)
    } catch (error) {
      logger.warn(
        { err: error, decisionId: decision.decisionId },
        'could not write the decision log',
      )
    }
  }
}
