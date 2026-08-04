import { describe, it, expect, beforeEach } from 'vitest'
import {
  OutcomeHandler,
  OutcomeContractError,
  type HandleOutcome,
  type TxnOutcomeEvent,
} from '../../src/consumer/outcomeHandler'
import { MemoryProcessedStore } from '../../src/store/processedStore'
import { DEFAULT_ROUTING_CONFIG, closedBreaker, emptyStats } from '../../src/domain/types'
import type { BreakerSnapshot, ChannelStats } from '../../src/domain/types'
import { fixedClock } from '../../src/lib/ports'

/**
 * The handler takes a plain object. It never sees a Redis client or a stream
 * identifier. That is the rule that lets the message pact call this same code
 * with no infrastructure at all.
 */

class FakeWindows {
  readonly records: Array<{ channelId: string; success: boolean; latencyMs: number }> = []
  private state = new Map<string, ChannelStats>()

  async record(
    channelId: string,
    outcome: { success: boolean; latencyMs: number },
  ): Promise<void> {
    this.records.push({ channelId, ...outcome })
    const current = this.state.get(channelId) ?? emptyStats(channelId)
    if (outcome.success) current.success += 1
    else current.failure += 1
    current.latencySamples.push(outcome.latencyMs)
    this.state.set(channelId, current)
  }

  async read(channelId: string): Promise<ChannelStats> {
    return this.state.get(channelId) ?? emptyStats(channelId)
  }

  seed(channelId: string, success: number, failure: number): void {
    this.state.set(channelId, {
      channelId,
      success,
      failure,
      latencySamples: Array.from({ length: success + failure }, () => 200),
    })
  }
}

class FakeBreakers {
  private state = new Map<string, BreakerSnapshot>()
  releases = 0

  async read(channelId: string): Promise<BreakerSnapshot> {
    return this.state.get(channelId) ?? closedBreaker()
  }

  async write(channelId: string, snapshot: BreakerSnapshot): Promise<void> {
    this.state.set(channelId, snapshot)
  }

  async releaseProbeSlot(): Promise<void> {
    this.releases += 1
  }

  set(channelId: string, snapshot: BreakerSnapshot): void {
    this.state.set(channelId, snapshot)
  }
}

const NOW = 1_700_000_000_000

const halfOpen = (probeSuccess: number): BreakerSnapshot => ({
  state: 'HALF_OPEN',
  openedAt: NOW - 40_000,
  probeSuccess,
})

function appliedBreaker(result: HandleOutcome): BreakerSnapshot {
  if (result.status !== 'applied') {
    throw new Error(`expected applied, got ${result.status}`)
  }
  return result.breaker
}

function validEvent(overrides: Partial<TxnOutcomeEvent> = {}): TxnOutcomeEvent {
  return {
    schemaVersion: 1,
    eventId: 'evt-1',
    eventType: 'txn.outcome',
    occurredAt: '2026-08-03T10:15:30.123Z',
    transactionId: 'txn-1',
    decisionId: 'dec_1',
    channelId: 'RAIL-B',
    status: 'success',
    latencyMs: 210,
    errorCode: null,
    attempt: 1,
    routingSource: 'switch',
    ...overrides,
  }
}

let windows: FakeWindows
let breakers: FakeBreakers
let processed: MemoryProcessedStore
let handler: OutcomeHandler

beforeEach(() => {
  windows = new FakeWindows()
  breakers = new FakeBreakers()
  processed = new MemoryProcessedStore()
  handler = new OutcomeHandler({
    windows,
    breakers,
    processed,
    clock: fixedClock(NOW),
    config: DEFAULT_ROUTING_CONFIG,
  })
})

describe('OutcomeHandler: the happy path', () => {
  it('writes the outcome into the window', async () => {
    const result = await handler.handle(validEvent())
    expect(result.status).toBe('applied')
    expect(windows.records).toEqual([
      { channelId: 'RAIL-B', success: true, latencyMs: 210 },
    ])
  })

  it('counts a failed payout as a failure', async () => {
    await handler.handle(
      validEvent({ status: 'failed', errorCode: 'INSUFFICIENT_FUNDS' }),
    )
    expect(windows.records[0]?.success).toBe(false)
  })

  it('accepts an outcome that came from the fallback path', async () => {
    // A fallback payout still happened on a real channel, so its result is
    // real evidence about that channel.
    const result = await handler.handle(
      validEvent({ routingSource: 'fallback', decisionId: 'fallback-abc' }),
    )
    expect(result.status).toBe('applied')
  })
})

describe('OutcomeHandler: repeated delivery', () => {
  it('applies the same event once', async () => {
    const event = validEvent()
    const first = await handler.handle(event)
    const second = await handler.handle(event)

    expect(first.status).toBe('applied')
    expect(second.status).toBe('duplicate')
    // Without this guard, one replayed failure counts twice and it opens a
    // breaker that should have stayed shut.
    expect(windows.records).toHaveLength(1)
  })

  it('treats two events with different identifiers as two events', async () => {
    await handler.handle(validEvent({ eventId: 'evt-1' }))
    await handler.handle(validEvent({ eventId: 'evt-2' }))
    expect(windows.records).toHaveLength(2)
  })
})

describe('OutcomeHandler: a broken shape', () => {
  it('throws when a field is missing', async () => {
    const { latencyMs, ...missing } = validEvent()
    void latencyMs
    await expect(handler.handle(missing)).rejects.toBeInstanceOf(OutcomeContractError)
  })

  it('throws when the status is a value this consumer does not know', async () => {
    await expect(
      handler.handle(validEvent({ status: 'pending' as never })),
    ).rejects.toBeInstanceOf(OutcomeContractError)
  })

  it('throws when the latency is a string', async () => {
    await expect(
      handler.handle(validEvent({ latencyMs: '210' as never })),
    ).rejects.toBeInstanceOf(OutcomeContractError)
  })

  it('throws for null and for a plain string', async () => {
    await expect(handler.handle(null)).rejects.toBeInstanceOf(OutcomeContractError)
    await expect(handler.handle('not an event')).rejects.toBeInstanceOf(
      OutcomeContractError,
    )
  })

  it('does not touch the window when the shape is broken', async () => {
    await handler.handle({ eventType: 'txn.outcome' }).catch(() => undefined)
    expect(windows.records).toHaveLength(0)
  })
})

describe('OutcomeHandler: a newer schema', () => {
  it('skips an event from a newer producer instead of guessing', async () => {
    const result = await handler.handle(validEvent({ schemaVersion: 2 }))
    expect(result.status).toBe('ignored')
    expect(windows.records).toHaveLength(0)
  })
})

describe('OutcomeHandler: an unknown channel', () => {
  it('skips an outcome for a channel that this service does not have', async () => {
    const strict = new OutcomeHandler({
      windows,
      breakers,
      processed,
      clock: fixedClock(NOW),
      config: DEFAULT_ROUTING_CONFIG,
      knownChannel: (channelId) => channelId === 'RAIL-A',
    })
    const result = await strict.handle(validEvent({ channelId: 'RAIL-Z' }))
    expect(result.status).toBe('ignored')
    expect(windows.records).toHaveLength(0)
  })
})

describe('OutcomeHandler: the breaker', () => {
  it('opens the breaker once the window proves the channel is bad', async () => {
    // 29 failures are already in the window. This event makes 30, all failed.
    windows.seed('RAIL-B', 0, 29)
    const result = await handler.handle(
      validEvent({ status: 'failed', errorCode: 'PROVIDER_DECLINED' }),
    )
    expect(result.status).toBe('applied')
    expect(appliedBreaker(result).state).toBe('OPEN')
  })

  it('leaves the breaker shut while the samples are too few', async () => {
    windows.seed('RAIL-B', 0, 2)
    const result = await handler.handle(validEvent({ status: 'failed' }))
    expect(appliedBreaker(result).state).toBe('CLOSED')
  })

  it('counts a good probe while the breaker is half open', async () => {
    breakers.set('RAIL-B', halfOpen(0))
    const result = await handler.handle(validEvent())
    const breaker = appliedBreaker(result)
    expect(breaker.state).toBe('HALF_OPEN')
    expect(breaker.probeSuccess).toBe(1)
  })

  it('closes the breaker on the last good probe', async () => {
    breakers.set('RAIL-B', halfOpen(DEFAULT_ROUTING_CONFIG.breaker.probesToClose - 1))
    const result = await handler.handle(validEvent())
    expect(appliedBreaker(result).state).toBe('CLOSED')
  })

  it('opens the breaker again on a failed probe', async () => {
    breakers.set('RAIL-B', halfOpen(2))
    const result = await handler.handle(validEvent({ status: 'failed' }))
    expect(appliedBreaker(result).state).toBe('OPEN')
  })

  it('gives the probe slot back after a probe, whatever the result', async () => {
    // Without the release, the channel keeps one slot taken and it can never
    // finish the probes it needs to recover.
    breakers.set('RAIL-B', halfOpen(0))
    await handler.handle(validEvent({ eventId: 'evt-good' }))
    breakers.set('RAIL-B', halfOpen(1))
    await handler.handle(validEvent({ eventId: 'evt-bad', status: 'failed' }))
    expect(breakers.releases).toBe(2)
  })

  it('does not read the window while the breaker is half open', async () => {
    // The window still holds the old failures. If they counted, the breaker
    // would open again at once and the probe would never finish.
    windows.seed('RAIL-B', 0, 50)
    breakers.set('RAIL-B', halfOpen(0))
    const result = await handler.handle(validEvent())
    expect(appliedBreaker(result).state).toBe('HALF_OPEN')
  })
})
