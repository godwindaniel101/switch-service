import { describe, it, expect } from 'vitest'
import { evaluateBreaker, recordProbe, openForMs } from '../../src/domain/breaker'
import {
  DEFAULT_ROUTING_CONFIG,
  closedBreaker,
  type BreakerSnapshot,
  type ChannelStats,
} from '../../src/domain/types'

/**
 * The breaker as a table. Every transition, in both directions.
 *
 * Both functions are pure and take `now`, so nothing here waits for a timer.
 */

const config = DEFAULT_ROUTING_CONFIG
const NOW = 1_000_000

function stats(success: number, failure: number): ChannelStats {
  return { channelId: 'RAIL-B', success, failure, latencySamples: [] }
}

const open = (openedAt = NOW): BreakerSnapshot => ({
  state: 'OPEN',
  openedAt,
  probeSuccess: 0,
})

const halfOpen = (probeSuccess = 0): BreakerSnapshot => ({
  state: 'HALF_OPEN',
  openedAt: NOW,
  probeSuccess,
})

describe('evaluateBreaker: CLOSED', () => {
  it('opens when the success rate falls below the threshold', () => {
    // 30 payouts, 12 good: a rate of 0.4, below the threshold of 0.5.
    const next = evaluateBreaker(closedBreaker(), stats(12, 18), config, NOW)
    expect(next.state).toBe('OPEN')
    expect(next.openedAt).toBe(NOW)
  })

  it('stays shut when the rate is on the threshold', () => {
    const next = evaluateBreaker(closedBreaker(), stats(15, 15), config, NOW)
    expect(next.state).toBe('CLOSED')
  })

  it('never opens with too few samples', () => {
    // Two failures out of two is not proof. This guard is the difference
    // between a breaker and a hair trigger.
    const next = evaluateBreaker(closedBreaker(), stats(0, 2), config, NOW)
    expect(next.state).toBe('CLOSED')
  })

  it('opens as soon as the samples reach the minimum', () => {
    const belowMinimum = evaluateBreaker(
      closedBreaker(),
      stats(0, config.minSamples - 1),
      config,
      NOW,
    )
    const atMinimum = evaluateBreaker(
      closedBreaker(),
      stats(0, config.minSamples),
      config,
      NOW,
    )
    expect(belowMinimum.state).toBe('CLOSED')
    expect(atMinimum.state).toBe('OPEN')
  })

  it('stays shut for an empty window', () => {
    const next = evaluateBreaker(closedBreaker(), stats(0, 0), config, NOW)
    expect(next.state).toBe('CLOSED')
  })
})

describe('evaluateBreaker: OPEN', () => {
  it('waits the full open time before it probes', () => {
    const tooSoon = evaluateBreaker(
      open(),
      stats(0, 30),
      config,
      NOW + config.breaker.openMs - 1,
    )
    expect(tooSoon.state).toBe('OPEN')
  })

  it('goes to half open after the open time', () => {
    const next = evaluateBreaker(
      open(),
      stats(0, 30),
      config,
      NOW + config.breaker.openMs,
    )
    expect(next.state).toBe('HALF_OPEN')
    expect(next.probeSuccess).toBe(0)
  })

  it('opens the channel again with no traffic at all', () => {
    // A blocked channel gets no payouts, so its window empties. The breaker
    // must still move on time, or the channel stays blocked forever.
    const next = evaluateBreaker(
      open(),
      stats(0, 0),
      config,
      NOW + config.breaker.openMs,
    )
    expect(next.state).toBe('HALF_OPEN')
  })
})

describe('evaluateBreaker: HALF_OPEN', () => {
  it('does not move on the window numbers', () => {
    // The window still holds the old failures. If they counted, the breaker
    // would open again at once and the probe would never finish.
    const next = evaluateBreaker(halfOpen(), stats(0, 40), config, NOW + 60_000)
    expect(next.state).toBe('HALF_OPEN')
  })
})

describe('recordProbe', () => {
  it('closes the breaker after enough good probes', () => {
    let snapshot = halfOpen(0)
    for (let i = 1; i < config.breaker.probesToClose; i += 1) {
      snapshot = recordProbe(snapshot, true, config, NOW)
      expect(snapshot.state).toBe('HALF_OPEN')
      expect(snapshot.probeSuccess).toBe(i)
    }
    snapshot = recordProbe(snapshot, true, config, NOW)
    expect(snapshot.state).toBe('CLOSED')
    expect(snapshot.probeSuccess).toBe(0)
    expect(snapshot.openedAt).toBe(0)
  })

  it('opens again on one failed probe', () => {
    // One failure is enough. The channel is not repaired.
    const next = recordProbe(halfOpen(2), false, config, NOW + 5_000)
    expect(next.state).toBe('OPEN')
    expect(next.openedAt).toBe(NOW + 5_000)
    expect(next.probeSuccess).toBe(0)
  })

  it('throws away the progress when a probe fails late', () => {
    const almost = halfOpen(config.breaker.probesToClose - 1)
    const next = recordProbe(almost, false, config, NOW)
    expect(next.state).toBe('OPEN')
  })

  it('changes nothing for a shut breaker', () => {
    const shut = closedBreaker()
    expect(recordProbe(shut, true, config, NOW)).toEqual(shut)
    expect(recordProbe(shut, false, config, NOW)).toEqual(shut)
  })

  it('changes nothing for an open breaker', () => {
    const blocked = open()
    expect(recordProbe(blocked, true, config, NOW)).toEqual(blocked)
  })
})

describe('the full cycle', () => {
  it('goes shut, open, half open, shut again', () => {
    let snapshot = closedBreaker()

    snapshot = evaluateBreaker(snapshot, stats(2, 28), config, NOW)
    expect(snapshot.state).toBe('OPEN')

    snapshot = evaluateBreaker(
      snapshot,
      stats(2, 28),
      config,
      NOW + config.breaker.openMs,
    )
    expect(snapshot.state).toBe('HALF_OPEN')

    for (let i = 0; i < config.breaker.probesToClose; i += 1) {
      snapshot = recordProbe(snapshot, true, config, NOW + config.breaker.openMs + i)
    }
    expect(snapshot.state).toBe('CLOSED')
  })

  it('goes back to open when the probe fails, and waits again', () => {
    let snapshot = open()
    snapshot = evaluateBreaker(
      snapshot,
      stats(0, 30),
      config,
      NOW + config.breaker.openMs,
    )
    expect(snapshot.state).toBe('HALF_OPEN')

    const failedAt = NOW + config.breaker.openMs + 100
    snapshot = recordProbe(snapshot, false, config, failedAt)
    expect(snapshot.state).toBe('OPEN')

    // The wait starts again from the new time, not from the first failure.
    const tooSoon = evaluateBreaker(
      snapshot,
      stats(0, 30),
      config,
      failedAt + config.breaker.openMs - 1,
    )
    expect(tooSoon.state).toBe('OPEN')
  })
})

describe('openForMs', () => {
  it('reports nothing for a shut breaker', () => {
    expect(openForMs(closedBreaker(), NOW)).toBeNull()
  })

  it('reports how long the breaker has been open', () => {
    expect(openForMs(open(NOW), NOW + 12_000)).toBe(12_000)
  })

  it('never reports a negative time', () => {
    expect(openForMs(open(NOW), NOW - 5_000)).toBe(0)
  })
})
