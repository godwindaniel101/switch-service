import { describe, it, expect } from 'vitest'
import {
  buildCandidates,
  costBoundsOf,
  costScoreOf,
  latencyScoreOf,
  scoreChannel,
} from '../../src/domain/scoring'
import {
  DEFAULT_ROUTING_CONFIG,
  closedBreaker,
  type BreakerSnapshot,
  type Channel,
  type ChannelStats,
} from '../../src/domain/types'

const config = DEFAULT_ROUTING_CONFIG

const channels: Channel[] = [
  { id: 'RAIL-A', name: 'A', cost: 1.2, enabled: true },
  { id: 'RAIL-B', name: 'B', cost: 1.0, enabled: true },
  { id: 'RAIL-C', name: 'C', cost: 0.8, enabled: true },
]

function stats(
  channelId: string,
  success: number,
  failure: number,
  latency: number[] = [],
): ChannelStats {
  return { channelId, success, failure, latencySamples: latency }
}

function statsMap(...entries: ChannelStats[]): Map<string, ChannelStats> {
  return new Map(entries.map((s) => [s.channelId, s]))
}

function breakerMap(
  entries: Record<string, BreakerSnapshot> = {},
): Map<string, BreakerSnapshot> {
  return new Map(Object.entries(entries))
}

const latencies = (count: number, ms: number): number[] =>
  Array.from({ length: count }, () => ms)

describe('the weights', () => {
  it('add to exactly one', () => {
    // If they do not, the score leaves the range 0 to 1 and no threshold in
    // the system means what it says.
    const { success, latency, cost } = config.weights
    expect(success + latency + cost).toBeCloseTo(1, 10)
  })
})

describe('costScoreOf', () => {
  it('gives 1 to the cheapest and 0 to the dearest', () => {
    const bounds = costBoundsOf(channels)
    expect(costScoreOf(0.8, bounds)).toBe(1)
    expect(costScoreOf(1.2, bounds)).toBe(0)
    expect(costScoreOf(1.0, bounds)).toBeCloseTo(0.5, 6)
  })

  it('is neutral when every channel costs the same', () => {
    // The division would be by zero. A NaN score sorts in a random way and
    // the routing becomes silent chaos.
    const same = costBoundsOf([
      { id: 'a', name: 'a', cost: 1, enabled: true },
      { id: 'b', name: 'b', cost: 1, enabled: true },
    ])
    expect(costScoreOf(1, same)).toBe(1)
    expect(Number.isNaN(costScoreOf(1, same))).toBe(false)
  })

  it('handles an empty channel list', () => {
    expect(costScoreOf(1, costBoundsOf([]))).toBe(1)
  })
})

describe('latencyScoreOf', () => {
  it('gives 1 to an instant channel and 0 at the ceiling', () => {
    expect(latencyScoreOf(0, config)).toBe(1)
    expect(latencyScoreOf(config.latencyCeilingMs, config)).toBe(0)
    expect(latencyScoreOf(config.latencyCeilingMs * 3, config)).toBe(0)
  })

  it('falls in a straight line between the two', () => {
    expect(latencyScoreOf(1_000, config)).toBeCloseTo(0.5, 6)
  })

  it('uses the cold-start default when the p95 is not known', () => {
    // `null` means unknown, and unknown is not the same as bad.
    expect(latencyScoreOf(null, config)).toBe(config.coldStart.latencyScore)
  })
})

describe('scoreChannel', () => {
  const bounds = costBoundsOf(channels)
  const channelA = channels[0] as Channel

  it('never returns NaN for an empty channel', () => {
    const result = scoreChannel(channelA, stats('RAIL-A', 0, 0), config, bounds)
    expect(Number.isNaN(result.score)).toBe(false)
    expect(Number.isFinite(result.score)).toBe(true)
    expect(result.samples).toBe(0)
  })

  it('marks a channel with too few samples as cold, and stays optimistic', () => {
    const result = scoreChannel(channelA, stats('RAIL-A', 2, 1), config, bounds)
    expect(result.coldStart).toBe(true)
    // An optimistic default lets a new channel earn traffic. A pessimistic
    // default starves it forever.
    expect(result.successRate).toBe(config.coldStart.successRate)
  })

  it('uses the measured rate once the samples pass the minimum', () => {
    const latency = latencies(30, 500)
    const result = scoreChannel(
      channelA,
      stats('RAIL-A', 27, 3, latency),
      config,
      bounds,
    )
    expect(result.coldStart).toBe(false)
    expect(result.successRate).toBeCloseTo(0.9, 6)
  })

  it('adds the three parts with the documented weights', () => {
    const latency = latencies(30, 1_000) // latency score 0.5
    const result = scoreChannel(
      channelA,
      stats('RAIL-A', 30, 0, latency),
      config,
      bounds,
    )
    // success 1.0 * 0.6 + latency 0.5 * 0.3 + cost 0 * 0.1 = 0.75
    expect(result.score).toBeCloseTo(0.75, 4)
  })

  it('keeps the score inside the range 0 to 1', () => {
    const worst = scoreChannel(
      channelA,
      stats('RAIL-A', 0, 50, latencies(50, 9_000)),
      config,
      bounds,
    )
    expect(worst.score).toBeGreaterThanOrEqual(0)
    expect(worst.score).toBeLessThanOrEqual(1)
  })
})

describe('buildCandidates', () => {
  it('puts the best score first', () => {
    const good = latencies(30, 100)
    const slow = latencies(30, 1_900)
    const candidates = buildCandidates(
      channels,
      statsMap(
        stats('RAIL-A', 30, 0, good),
        stats('RAIL-B', 20, 10, slow),
        stats('RAIL-C', 15, 15, slow),
      ),
      breakerMap(),
      config,
    )
    expect(candidates[0]?.channelId).toBe('RAIL-A')
    expect(candidates[0]?.rank).toBe(1)
    expect(candidates.map((c) => c.rank)).toEqual([1, 2, 3])
  })

  it('breaks a tie by the channel identifier, so the order is stable', () => {
    // A random order for equal scores makes every test flaky and every
    // incident hard to read.
    const same = statsMap(
      stats('RAIL-A', 0, 0),
      stats('RAIL-B', 0, 0),
      stats('RAIL-C', 0, 0),
    )
    const equalCost: Channel[] = channels.map((c) => ({ ...c, cost: 1 }))
    const first = buildCandidates(equalCost, same, breakerMap(), config)
    const second = buildCandidates(equalCost, same, breakerMap(), config)
    expect(first.map((c) => c.channelId)).toEqual(second.map((c) => c.channelId))
    expect(first.map((c) => c.channelId)).toEqual(['RAIL-A', 'RAIL-B', 'RAIL-C'])
  })

  it('puts an open breaker last, whatever its score says', () => {
    const perfect = latencies(30, 50)
    const candidates = buildCandidates(
      channels,
      statsMap(
        stats('RAIL-A', 30, 0, perfect),
        stats('RAIL-B', 0, 0),
        stats('RAIL-C', 0, 0),
      ),
      breakerMap({ 'RAIL-A': { state: 'OPEN', openedAt: 1_000, probeSuccess: 0 } }),
      config,
    )
    // RAIL-A has the best numbers, and it is still last. An OPEN breaker is
    // not a preference, it is a block.
    expect(candidates[candidates.length - 1]?.channelId).toBe('RAIL-A')
    expect(candidates[candidates.length - 1]?.eligible).toBe(false)
    expect(candidates[candidates.length - 1]?.ineligibleReason).toBe('breaker-open')
  })

  it('marks a disabled channel as not eligible', () => {
    const withDisabled: Channel[] = [
      { id: 'RAIL-A', name: 'A', cost: 1, enabled: false },
      { id: 'RAIL-B', name: 'B', cost: 1, enabled: true },
    ]
    const candidates = buildCandidates(
      withDisabled,
      statsMap(stats('RAIL-A', 0, 0), stats('RAIL-B', 0, 0)),
      breakerMap(),
      config,
    )
    const a = candidates.find((c) => c.channelId === 'RAIL-A')
    expect(a?.eligible).toBe(false)
    expect(a?.ineligibleReason).toBe('channel-disabled')
  })

  it('gives a candidate for a channel with no window at all', () => {
    const candidates = buildCandidates(channels, new Map(), breakerMap(), config)
    expect(candidates).toHaveLength(3)
    for (const candidate of candidates) {
      expect(candidate.samples).toBe(0)
      expect(candidate.coldStart).toBe(true)
      expect(candidate.eligible).toBe(true)
      expect(Number.isNaN(candidate.score)).toBe(false)
    }
  })

  it('reads a half-open breaker as eligible', () => {
    // A half-open breaker must receive a probe. If it were not eligible, the
    // channel could never prove that it recovered.
    const candidates = buildCandidates(
      channels,
      new Map(),
      breakerMap({
        'RAIL-B': { state: 'HALF_OPEN', openedAt: 1_000, probeSuccess: 1 },
      }),
      config,
    )
    const b = candidates.find((c) => c.channelId === 'RAIL-B')
    expect(b?.eligible).toBe(true)
    expect(b?.breakerState).toBe('HALF_OPEN')
  })

  it('reports the breaker state of every channel', () => {
    const candidates = buildCandidates(
      channels,
      new Map(),
      breakerMap({ 'RAIL-C': closedBreaker() }),
      config,
    )
    for (const candidate of candidates) {
      expect(['CLOSED', 'OPEN', 'HALF_OPEN']).toContain(candidate.breakerState)
    }
  })
})
