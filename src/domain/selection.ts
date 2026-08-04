import type { Candidate, RouteStrategy, RoutingConfig } from './types'

/**
 * Chooses one channel from the ranked candidates.
 *
 * Exploration: a small share of payouts goes to a channel that is not the
 * best. Without it, a channel that recovers gets no traffic, its window stays
 * empty, and it never proves that it is healthy again.
 *
 * The random source is a port. The domain never calls Math.random().
 */

export interface Rng {
  next(): number
}

export interface Selection {
  channelId: string
  strategy: RouteStrategy
}

export class NoEligibleChannelError extends Error {
  constructor(readonly reasons: Array<{ channelId: string; reason: string }>) {
    super('no channel is eligible for this corridor')
    this.name = 'NoEligibleChannelError'
  }
}

/**
 * The candidates must already be in rank order. `buildCandidates` does that,
 * and it puts every eligible channel before every blocked one.
 */
export function selectChannel(
  candidates: readonly Candidate[],
  config: RoutingConfig,
  rng: Rng,
): Selection {
  const eligible = candidates.filter((c) => c.eligible)

  if (eligible.length === 0) {
    throw new NoEligibleChannelError(
      candidates.map((c) => ({
        channelId: c.channelId,
        reason: c.ineligibleReason ?? 'unknown',
      })),
    )
  }

  const best = eligible[0] as Candidate

  // With one channel there is nothing to explore. Say so in the strategy, so
  // an operator does not read the choice as a judgement.
  if (eligible.length === 1) {
    return { channelId: best.channelId, strategy: 'only-candidate' }
  }

  const draw = rng.next()
  if (draw < config.explorationRate) {
    const others = eligible.slice(1)
    const pick = Math.min(others.length - 1, Math.floor(rng.next() * others.length))
    const chosen = others[Math.max(0, pick)] as Candidate
    // Exploration never reaches a blocked channel. `others` holds eligible
    // channels only, so an OPEN breaker can never be selected here.
    return { channelId: chosen.channelId, strategy: 'explore' }
  }

  return { channelId: best.channelId, strategy: 'best' }
}
