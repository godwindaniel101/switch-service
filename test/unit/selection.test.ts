import { describe, it, expect } from 'vitest'
import { selectChannel, NoEligibleChannelError } from '../../src/domain/selection'
import { DEFAULT_ROUTING_CONFIG, type Candidate } from '../../src/domain/types'
import { sequenceRng } from '../../src/lib/ports'

const config = DEFAULT_ROUTING_CONFIG

function candidate(
  channelId: string,
  rank: number,
  score: number,
  overrides: Partial<Candidate> = {},
): Candidate {
  return {
    channelId,
    rank,
    score,
    successRate: 0.9,
    p95Ms: 200,
    costScore: 0.5,
    breakerState: 'CLOSED',
    samples: 50,
    coldStart: false,
    eligible: true,
    ineligibleReason: null,
    ...overrides,
  }
}

const three = [
  candidate('RAIL-A', 1, 0.9),
  candidate('RAIL-B', 2, 0.7),
  candidate('RAIL-C', 3, 0.6),
]

describe('selectChannel', () => {
  it('takes the best channel when the draw is above the exploration rate', () => {
    const selection = selectChannel(three, config, sequenceRng([0.9]))
    expect(selection.channelId).toBe('RAIL-A')
    expect(selection.strategy).toBe('best')
  })

  it('explores when the draw is below the exploration rate', () => {
    // draw 1 = 0.05, below 0.1, so explore.
    // draw 2 = 0.0, so the first of the others.
    const selection = selectChannel(three, config, sequenceRng([0.05, 0]))
    expect(selection.channelId).toBe('RAIL-B')
    expect(selection.strategy).toBe('explore')
  })

  it('never explores into the best channel', () => {
    for (const second of [0, 0.25, 0.5, 0.75, 0.99]) {
      const selection = selectChannel(three, config, sequenceRng([0.01, second]))
      expect(selection.strategy).toBe('explore')
      expect(selection.channelId).not.toBe('RAIL-A')
    }
  })

  it('reaches every channel that is not the best', () => {
    const reached = new Set<string>()
    for (const second of [0, 0.99]) {
      reached.add(selectChannel(three, config, sequenceRng([0.01, second])).channelId)
    }
    expect([...reached].sort()).toEqual(['RAIL-B', 'RAIL-C'])
  })

  it('gives the expected split for a fixed sequence', () => {
    // Ten decisions, one of them below the exploration rate.
    const draws = [0.5, 0.5, 0.5, 0.5, 0.05, 0, 0.5, 0.5, 0.5, 0.5, 0.5]
    const rng = sequenceRng(draws)
    const picks: string[] = []
    for (let i = 0; i < 10; i += 1) {
      picks.push(selectChannel(three, config, rng).channelId)
    }
    const explored = picks.filter((p) => p !== 'RAIL-A').length
    expect(explored).toBe(1)
  })

  it('never selects a blocked channel, not even while exploring', () => {
    const withBlocked = [
      candidate('RAIL-A', 1, 0.9),
      candidate('RAIL-B', 2, 0.8),
      candidate('RAIL-C', 3, 0.0, {
        eligible: false,
        ineligibleReason: 'breaker-open',
        breakerState: 'OPEN',
      }),
    ]
    for (let i = 0; i < 20; i += 1) {
      const selection = selectChannel(
        withBlocked,
        config,
        sequenceRng([0.01, i / 20]),
      )
      expect(selection.channelId).not.toBe('RAIL-C')
    }
  })

  it('does not explore when only one channel is eligible', () => {
    const onlyOne = [
      candidate('RAIL-A', 1, 0.9),
      candidate('RAIL-B', 2, 0.8, {
        eligible: false,
        ineligibleReason: 'breaker-open',
      }),
    ]
    const selection = selectChannel(onlyOne, config, sequenceRng([0.0, 0.0]))
    expect(selection.channelId).toBe('RAIL-A')
    // The strategy says why, so an operator does not read the choice as a
    // judgement about the channel.
    expect(selection.strategy).toBe('only-candidate')
  })

  it('fails clearly when every channel is blocked', () => {
    const allBlocked = three.map((c) => ({
      ...c,
      eligible: false,
      ineligibleReason: 'breaker-open',
    }))
    let caught: unknown
    try {
      selectChannel(allBlocked, config, sequenceRng([0.5]))
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(NoEligibleChannelError)
    // The reason for each channel travels with the error. Without it, an
    // operator cannot tell a blocked channel from a disabled one.
    expect((caught as NoEligibleChannelError).reasons).toHaveLength(3)
  })

  it('fails clearly for an empty candidate list', () => {
    expect(() => selectChannel([], config, sequenceRng([0.5]))).toThrow(
      NoEligibleChannelError,
    )
  })

  it('does not explore when the rate is zero', () => {
    const noExploration = { ...config, explorationRate: 0 }
    for (const draw of [0, 0.0001, 0.5, 0.99]) {
      const selection = selectChannel(three, noExploration, sequenceRng([draw, 0]))
      expect(selection.strategy).toBe('best')
    }
  })
})
