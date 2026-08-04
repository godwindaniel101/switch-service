import path from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  MessageConsumerPact,
  MatchersV3,
  SpecificationVersion,
} from '@pact-foundation/pact'
import { OutcomeHandler } from '../../src/consumer/outcomeHandler'
import { MemoryProcessedStore } from '../../src/store/processedStore'
import { DEFAULT_ROUTING_CONFIG, closedBreaker } from '../../src/domain/types'
import type { BreakerSnapshot, ChannelStats } from '../../src/domain/types'
import { fixedClock } from '../../src/lib/ports'

/**
 * PAIR 2 — the message contract, consumer side.
 *
 *   consumer  switch-service         (this repository)
 *   producer  disbursement-service   (a different repository)
 *
 * The direction of a contract follows the DATA, not the call. The switch
 * reads the outcome event, so the switch is the consumer, and this file says
 * what the switch needs.
 *
 * This test does NOT test Redis. It tests the payload and the handler. The
 * stream, the consumer group and the acknowledgement belong to an integration
 * test.
 *
 * The handler runs for real. It takes a plain object, so no broker, no Redis
 * and no database is needed here.
 */

const { like, integer, regex, string } = MatchersV3

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(Z|[+-]\d{2}:\d{2})$/

/**
 * Takes the message body out of the envelope and gives it to the handler.
 *
 * The library helper `asynchronousBodyHandler` passes `message.contents`, but
 * in this version of pact-js the body sits one level deeper, at
 * `contents.content`. This adapter reads both shapes, so an upgrade of the
 * library cannot break the test in a quiet way.
 *
 * The handler still receives a PLAIN OBJECT, which is the rule that matters.
 */
function messageBody(
  handle: (body: unknown) => Promise<unknown>,
): (message: unknown) => Promise<unknown> {
  return (message: unknown) => {
    const envelope = message as { contents?: { content?: unknown } }
    const body =
      envelope?.contents && 'content' in envelope.contents
        ? envelope.contents.content
        : envelope?.contents
    return handle(body)
  }
}

function newMessagePact(): MessageConsumerPact {
  return new MessageConsumerPact({
    consumer: 'switch-service',
    provider: 'disbursement-service',
    dir: path.resolve(process.cwd(), 'pacts'),
    logLevel: 'warn',
    spec: SpecificationVersion.SPECIFICATION_VERSION_V3,
  })
}

/** A handler with in-memory stores. The real code, none of the plumbing. */
function newHandler(seed?: { breaker?: BreakerSnapshot; stats?: ChannelStats }) {
  const windowRecords: Array<{ channelId: string; success: boolean }> = []
  const breakerState = new Map<string, BreakerSnapshot>()
  if (seed?.breaker) breakerState.set('RAIL-A', seed.breaker)

  const handler = new OutcomeHandler({
    windows: {
      async record(channelId, outcome) {
        windowRecords.push({ channelId, success: outcome.success })
      },
      async read(channelId) {
        return (
          seed?.stats ?? {
            channelId,
            success: 0,
            failure: 0,
            latencySamples: [],
          }
        )
      },
    },
    breakers: {
      async read(channelId) {
        return breakerState.get(channelId) ?? closedBreaker()
      },
      async write(channelId, snapshot) {
        breakerState.set(channelId, snapshot)
      },
      async releaseProbeSlot() {
        // Nothing to release in memory.
      },
    },
    processed: new MemoryProcessedStore(),
    clock: fixedClock(Date.parse('2026-08-03T10:15:31.000Z')),
    config: DEFAULT_ROUTING_CONFIG,
  })

  return { handler, windowRecords, breakerState }
}

describe('switch-service reads the outcome event of disbursement-service', () => {
  it('reads the event of a successful payout', async () => {
    const { handler, windowRecords } = newHandler()

    await newMessagePact()
      .given('a payout succeeded on RAIL-A')
      .expectsToReceive('an outcome event for a successful payout')
      .withMetadata({ contentType: 'application/json' })
      .withContent({
        // The version tells this consumer whether it can read the event.
        schemaVersion: integer(1),
        eventId: like('9f2b1c7e-4a55-4c0e-8b21-5f7d3a9e1c04'),
        // An exact value. The consumer routes on this string.
        eventType: string('txn.outcome'),
        // The format is part of the contract. A different format is the most
        // common cause of a broken message pact.
        occurredAt: regex(ISO_8601, '2026-08-03T10:15:30.123Z'),
        transactionId: like('7f1c9f2a-2b0d-4c51-9f0b-8a1d3c5e7b91'),
        // A fallback payout has a decisionId too. Without one, the switch
        // cannot join the outcome to a decision.
        decisionId: like('dec_01H9ZQ7M4K'),
        channelId: string('RAIL-A'),
        // An exact value, and the whole set. A new status would change the
        // meaning of the window, so it must break this test.
        status: string('success'),
        latencyMs: integer(214),
        errorCode: null,
        attempt: integer(1),
        routingSource: string('switch'),
      })
      .verify(messageBody(async (body) => handler.handle(body)))

    // Prove that the handler did the work, and did not only accept the shape.
    expect(windowRecords).toEqual([{ channelId: 'RAIL-A', success: true }])
  })

  it('reads the event of a failed payout, with its reason', async () => {
    const { handler, windowRecords } = newHandler()

    await newMessagePact()
      .given('a payout failed on RAIL-A with INSUFFICIENT_FUNDS')
      .expectsToReceive('an outcome event for a failed payout')
      .withMetadata({ contentType: 'application/json' })
      .withContent({
        schemaVersion: integer(1),
        eventId: like('1c8d5e2f-77aa-4b3c-9d10-2e4f6a8b0c13'),
        eventType: string('txn.outcome'),
        occurredAt: regex(ISO_8601, '2026-08-03T10:15:33.456Z'),
        transactionId: like('2a4c6e80-1357-4bd9-8ace-13579bdf2468'),
        decisionId: like('dec_01H9ZQ7M4M'),
        channelId: string('RAIL-A'),
        status: string('failed'),
        latencyMs: integer(1_840),
        // A failed payout carries a reason. The switch shows it to an
        // operator, so a string is required here and null is not enough.
        errorCode: string('INSUFFICIENT_FUNDS'),
        attempt: integer(1),
        routingSource: string('switch'),
      })
      .verify(messageBody(async (body) => handler.handle(body)))

    expect(windowRecords).toEqual([{ channelId: 'RAIL-A', success: false }])
  })

  it('reads an event that the fallback path produced', async () => {
    const { handler, windowRecords } = newHandler()

    await newMessagePact()
      .given('a payout went out on the fallback channel because the switch was down')
      .expectsToReceive('an outcome event from the fallback path')
      .withMetadata({ contentType: 'application/json' })
      .withContent({
        schemaVersion: integer(1),
        eventId: like('55ab77cd-99ef-4011-8223-44556677aa99'),
        eventType: string('txn.outcome'),
        occurredAt: regex(ISO_8601, '2026-08-03T10:15:35.000Z'),
        transactionId: like('3b5d7f91-2468-4ace-9bdf-13579ace2468'),
        // The fallback identifier still exists, and it has a prefix.
        decisionId: regex(/^fallback-.+/, 'fallback-9f2b1c7e-4a55-4c0e-8b21-5f7d3a9e1c04'),
        channelId: string('RAIL-A'),
        status: string('success'),
        latencyMs: integer(198),
        errorCode: null,
        attempt: integer(1),
        // The switch counts a fallback outcome as real evidence about the
        // channel, so it must be able to read this value.
        routingSource: string('fallback'),
      })
      .verify(messageBody(async (body) => handler.handle(body)))

    expect(windowRecords).toHaveLength(1)
  })
})
