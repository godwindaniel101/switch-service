import { p95 } from './percentile'
import { emptyStats } from './types'
import type {
  Candidate,
  Channel,
  ChannelStats,
  BreakerSnapshot,
  BreakerState,
  RoutingConfig,
} from './types'

/**
 * The channel score.
 *
 *   score = 0.6 * successRate
 *         + 0.3 * latencyScore
 *         + 0.1 * costScore
 *
 * Every part runs from 0 to 1, so the score also runs from 0 to 1. A larger
 * score is better.
 *
 * This module is pure. It reads no clock, no Redis and no configuration file.
 */

export interface CostBounds {
  min: number
  max: number
}

export function costBoundsOf(channels: readonly Channel[]): CostBounds {
  if (channels.length === 0) return { min: 0, max: 0 }
  const costs = channels.map((c) => c.cost)
  return { min: Math.min(...costs), max: Math.max(...costs) }
}

/**
 * A cheap channel scores 1 and the dearest scores 0.
 *
 * When every channel costs the same, the part is neutral for all of them.
 * The division would be by zero, and a NaN score sorts in a random way.
 */
export function costScoreOf(cost: number, bounds: CostBounds): number {
  const spread = bounds.max - bounds.min
  if (spread <= 0) return 1
  return clamp01(1 - (cost - bounds.min) / spread)
}

/** A fast channel scores 1. A channel at the ceiling or above scores 0. */
export function latencyScoreOf(
  p95Ms: number | null,
  config: RoutingConfig,
): number {
  if (p95Ms === null) return clamp01(config.coldStart.latencyScore)
  if (config.latencyCeilingMs <= 0) return 0
  return clamp01(1 - Math.min(p95Ms / config.latencyCeilingMs, 1))
}

export interface ScoredChannel {
  score: number
  successRate: number
  p95Ms: number | null
  costScore: number
  samples: number
  coldStart: boolean
}

/**
 * Scores one channel.
 *
 * Cold start: below `minSamples` payouts the rates are not reliable, so the
 * score uses an optimistic default. An optimistic default lets a new channel
 * earn traffic. A pessimistic default starves it forever.
 */
export function scoreChannel(
  channel: Channel,
  stats: ChannelStats,
  config: RoutingConfig,
  bounds: CostBounds,
): ScoredChannel {
  const samples = stats.success + stats.failure
  const coldStart = samples < config.minSamples

  // Guard the division. An empty channel must not produce NaN.
  const observedRate = samples === 0 ? 0 : stats.success / samples
  const successRate = coldStart ? clamp01(config.coldStart.successRate) : observedRate

  const measuredP95 = p95(stats.latencySamples)
  const latencyScore = latencyScoreOf(measuredP95, config)
  const costScore = costScoreOf(channel.cost, bounds)

  const score =
    config.weights.success * successRate +
    config.weights.latency * latencyScore +
    config.weights.cost * costScore

  return {
    score: round4(clamp01(score)),
    successRate: round4(successRate),
    p95Ms: measuredP95,
    costScore: round4(costScore),
    samples,
    coldStart,
  }
}

/**
 * Scores every channel and puts them in order.
 *
 * The order is by score, largest first. Equal scores are broken by the
 * channel identifier, so the order is stable. A random order for equal
 * scores would make every test flaky and every incident hard to read.
 */
export function buildCandidates(
  channels: readonly Channel[],
  statsById: ReadonlyMap<string, ChannelStats>,
  breakersById: ReadonlyMap<string, BreakerSnapshot>,
  config: RoutingConfig,
): Candidate[] {
  const bounds = costBoundsOf(channels)

  const scored = channels.map((channel) => {
    const stats = statsById.get(channel.id) ?? emptyStats(channel.id)
    const breaker = breakersById.get(channel.id)
    const breakerState = breaker?.state ?? 'CLOSED'
    const result = scoreChannel(channel, stats, config, bounds)

    return {
      channelId: channel.id,
      rank: 0,
      score: result.score,
      successRate: result.successRate,
      p95Ms: result.p95Ms,
      costScore: result.costScore,
      breakerState,
      samples: result.samples,
      coldStart: result.coldStart,
      ...eligibilityOf(channel, breakerState),
    } satisfies Candidate
  })

  scored.sort((a, b) => {
    // An eligible channel always comes before an ineligible one, whatever the
    // score says. An OPEN breaker is not a preference, it is a block.
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1
    if (b.score !== a.score) return b.score - a.score
    return a.channelId.localeCompare(b.channelId)
  })

  scored.forEach((candidate, index) => {
    candidate.rank = index + 1
  })

  return scored
}

function eligibilityOf(
  channel: Channel,
  breakerState: BreakerState,
): { eligible: boolean; ineligibleReason: string | null } {
  if (!channel.enabled) {
    return { eligible: false, ineligibleReason: 'channel-disabled' }
  }
  if (breakerState === 'OPEN') {
    return { eligible: false, ineligibleReason: 'breaker-open' }
  }
  return { eligible: true, ineligibleReason: null }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}
