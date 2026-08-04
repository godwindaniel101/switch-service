import { closedBreaker } from './types'
import type { BreakerSnapshot, ChannelStats, RoutingConfig } from './types'

/**
 * The circuit breaker.
 *
 *   CLOSED     --failure rate at or above the threshold, with enough samples-->  OPEN
 *   OPEN       --after openMs-->                                                 HALF_OPEN
 *   HALF_OPEN  --enough good probes-->                                           CLOSED
 *   HALF_OPEN  --one failed probe-->                                             OPEN
 *
 * Both functions are pure. They take the current state, the numbers and
 * `now`, and they return the next state. A test drives them as a table.
 */

/**
 * Moves the breaker with the window numbers.
 *
 * This runs before every routing decision and after every outcome event.
 */
export function evaluateBreaker(
  current: BreakerSnapshot,
  stats: ChannelStats,
  config: RoutingConfig,
  now: number,
): BreakerSnapshot {
  const samples = stats.success + stats.failure

  switch (current.state) {
    case 'CLOSED': {
      // Never open with too few samples. A channel with two failures out of
      // two is not proven bad, and an early block starves a good channel.
      if (samples < config.minSamples) return current

      const successRate = samples === 0 ? 1 : stats.success / samples
      if (successRate < config.breaker.failureRateThreshold) {
        return { state: 'OPEN', openedAt: now, probeSuccess: 0 }
      }
      return current
    }

    case 'OPEN': {
      if (now - current.openedAt >= config.breaker.openMs) {
        return { state: 'HALF_OPEN', openedAt: current.openedAt, probeSuccess: 0 }
      }
      return current
    }

    case 'HALF_OPEN':
      // Only a probe result moves a half-open breaker. The window numbers
      // still hold the old failures, and they would open it again at once.
      return current

    default:
      return current
  }
}

/**
 * Applies the result of one probe.
 *
 * A probe is a payout that the router allowed through while the breaker was
 * HALF_OPEN.
 */
export function recordProbe(
  current: BreakerSnapshot,
  success: boolean,
  config: RoutingConfig,
  now: number,
): BreakerSnapshot {
  if (current.state !== 'HALF_OPEN') return current

  if (!success) {
    // One failed probe is enough. The channel is not repaired.
    return { state: 'OPEN', openedAt: now, probeSuccess: 0 }
  }

  const probeSuccess = current.probeSuccess + 1
  if (probeSuccess >= config.breaker.probesToClose) {
    return closedBreaker()
  }
  return { state: 'HALF_OPEN', openedAt: current.openedAt, probeSuccess }
}

/** How long the breaker has been open. Used by the console only. */
export function openForMs(snapshot: BreakerSnapshot, now: number): number | null {
  if (snapshot.state === 'CLOSED') return null
  return Math.max(0, now - snapshot.openedAt)
}
