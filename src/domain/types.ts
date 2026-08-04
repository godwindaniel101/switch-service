/**
 * The types of the routing domain.
 *
 * Nothing here reads Redis, Postgres or the clock. Every function that uses
 * these types takes `now` as an argument. That rule is the reason every unit
 * test in this repository is exact.
 */

export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

export type RouteStrategy = 'best' | 'explore' | 'only-candidate' | 'degraded'

/** A channel that this service can select. */
export interface Channel {
  id: string
  name: string
  /** The relative price of the channel. A smaller number is cheaper. */
  cost: number
  enabled: boolean
}

/** What the window holds for one channel. */
export interface ChannelStats {
  channelId: string
  success: number
  failure: number
  /** The latency values kept in the window. The p95 comes from these. */
  latencySamples: number[]
}

export interface BreakerSnapshot {
  state: BreakerState
  /** When the breaker last went to OPEN. Zero when it was never open. */
  openedAt: number
  /** The count of good probes since the breaker went to HALF_OPEN. */
  probeSuccess: number
}

export interface Candidate {
  channelId: string
  rank: number
  score: number
  /** The success rate that the score used. See `coldStart`. */
  successRate: number
  /** `null` when the window holds too few samples to give a real value. */
  p95Ms: number | null
  costScore: number
  breakerState: BreakerState
  /** The count of payouts in the window: success plus failure. */
  samples: number
  /**
   * True when the window holds fewer than `minSamples` payouts. The score
   * then uses an optimistic default, so a new channel can earn traffic.
   */
  coldStart: boolean
  eligible: boolean
  ineligibleReason: string | null
}

export interface RoutingDecision {
  decisionId: string
  channelId: string
  strategy: RouteStrategy
  windowMs: number
  evaluatedAt: string
  candidates: Candidate[]
}

export interface RoutingConfig {
  windowMs: number
  bucketMs: number
  maxSamplesPerBucket: number
  /** Below this count of payouts, a channel is cold and the breaker stays shut. */
  minSamples: number
  /** A p95 at or above this value scores zero for latency. */
  latencyCeilingMs: number
  weights: {
    success: number
    latency: number
    cost: number
  }
  breaker: {
    failureRateThreshold: number
    openMs: number
    probesToClose: number
  }
  explorationRate: number
  coldStart: {
    successRate: number
    latencyScore: number
  }
}

export const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
  windowMs: 60_000,
  bucketMs: 5_000,
  maxSamplesPerBucket: 200,
  minSamples: 20,
  latencyCeilingMs: 2_000,
  weights: { success: 0.6, latency: 0.3, cost: 0.1 },
  breaker: { failureRateThreshold: 0.5, openMs: 30_000, probesToClose: 3 },
  explorationRate: 0.1,
  coldStart: { successRate: 0.8, latencyScore: 0.5 },
}

export function emptyStats(channelId: string): ChannelStats {
  return { channelId, success: 0, failure: 0, latencySamples: [] }
}

export function closedBreaker(): BreakerSnapshot {
  return { state: 'CLOSED', openedAt: 0, probeSuccess: 0 }
}
