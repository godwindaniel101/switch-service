import { z } from 'zod'
import { evaluateBreaker, recordProbe } from '../domain/breaker'
import type { BreakerSnapshot, RoutingConfig } from '../domain/types'
import type { Clock } from '../lib/ports'

/**
 * PAIR 2 — the message contract, consumer side.
 *
 *   consumer  switch-service          (this repository)
 *   producer  disbursement-service    (a different repository)
 *
 * THIS FILE IS THIS SERVICE'S OWN DECLARATION OF THE EVENT.
 *
 * disbursement-service has a separate declaration in its own repository. The
 * duplication is deliberate: it is the thing the message pact tests.
 *
 * The handler takes a PLAIN OBJECT. It never sees a Redis client, a stream
 * identifier or a message envelope. That rule is what lets the message pact
 * call the real handler with no infrastructure at all.
 */

export const outcomeEventSchema = z.object({
  schemaVersion: z.number().int().positive(),
  eventId: z.string().min(1),
  eventType: z.literal('txn.outcome'),
  occurredAt: z.string().min(1),
  transactionId: z.string().min(1),
  decisionId: z.string().min(1),
  channelId: z.string().min(1),
  status: z.enum(['success', 'failed']),
  latencyMs: z.number().int().nonnegative(),
  errorCode: z.string().nullable(),
  attempt: z.number().int().positive(),
  routingSource: z.enum(['switch', 'fallback']),
})

export type TxnOutcomeEvent = z.infer<typeof outcomeEventSchema>

/** The highest schema version that this consumer understands. */
export const MAX_SUPPORTED_SCHEMA_VERSION = 1

export class OutcomeContractError extends Error {
  constructor(readonly detail: string) {
    super(`the outcome event does not match the contract: ${detail}`)
    this.name = 'OutcomeContractError'
  }
}

export type HandleOutcome =
  | { status: 'applied'; channelId: string; breaker: BreakerSnapshot }
  | { status: 'duplicate'; eventId: string }
  | { status: 'ignored'; reason: string }

export interface WindowWriter {
  record(
    channelId: string,
    outcome: { success: boolean; latencyMs: number },
    now: number,
  ): Promise<void>
  read(channelId: string, now: number): Promise<{
    channelId: string
    success: number
    failure: number
    latencySamples: number[]
  }>
}

export interface BreakerReadWriter {
  read(channelId: string): Promise<BreakerSnapshot>
  write(channelId: string, snapshot: BreakerSnapshot): Promise<void>
  releaseProbeSlot(channelId: string): Promise<void>
}

export interface OutcomeHandlerDeps {
  windows: WindowWriter
  breakers: BreakerReadWriter
  processed: { claim(eventId: string): Promise<boolean> }
  clock: Clock
  config: RoutingConfig
  knownChannel?: (channelId: string) => Promise<boolean> | boolean
  onApplied?: (event: TxnOutcomeEvent, breaker: BreakerSnapshot) => void
}

export class OutcomeHandler {
  constructor(private readonly deps: OutcomeHandlerDeps) {}

  /**
   * Applies one outcome to the window and to the breaker.
   *
   * Order of work:
   *   1. Read the event. A bad shape is a contract break, and it throws.
   *   2. Claim the event identifier. A repeat stops here.
   *   3. Write the outcome into the current bucket.
   *   4. Move the breaker with the fresh numbers.
   */
  async handle(message: unknown): Promise<HandleOutcome> {
    const parsed = outcomeEventSchema.safeParse(message)
    if (!parsed.success) {
      throw new OutcomeContractError(
        parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; '),
      )
    }
    const event = parsed.data

    // A future version can carry a meaning that this code cannot read. Skip
    // it and say so. Do not guess.
    if (event.schemaVersion > MAX_SUPPORTED_SCHEMA_VERSION) {
      return {
        status: 'ignored',
        reason: `schemaVersion ${event.schemaVersion} is newer than this consumer`,
      }
    }

    if (this.deps.knownChannel) {
      const known = await this.deps.knownChannel(event.channelId)
      if (!known) {
        // An outcome for a channel that this service does not have would
        // build a window that no decision can ever use.
        return { status: 'ignored', reason: `unknown channel ${event.channelId}` }
      }
    }

    const claimed = await this.deps.processed.claim(event.eventId)
    if (!claimed) return { status: 'duplicate', eventId: event.eventId }

    const now = this.deps.clock.now()
    const success = event.status === 'success'

    await this.deps.windows.record(
      event.channelId,
      { success, latencyMs: event.latencyMs },
      now,
    )

    const breaker = await this.applyToBreaker(event.channelId, success, now)
    this.deps.onApplied?.(event, breaker)

    return { status: 'applied', channelId: event.channelId, breaker }
  }

  private async applyToBreaker(
    channelId: string,
    success: boolean,
    now: number,
  ): Promise<BreakerSnapshot> {
    const current = await this.deps.breakers.read(channelId)

    // A HALF_OPEN breaker moves on the probe result only. The window still
    // holds the old failures, and they would open it again at once.
    if (current.state === 'HALF_OPEN') {
      const next = recordProbe(current, success, this.deps.config, now)
      if (!sameSnapshot(current, next)) {
        await this.deps.breakers.write(channelId, next)
      }
      // Give the probe slot back, whatever the result. The next payout may
      // probe again if the breaker is still half open.
      await this.deps.breakers.releaseProbeSlot(channelId)
      return next
    }

    const stats = await this.deps.windows.read(channelId, now)
    const next = evaluateBreaker(current, stats, this.deps.config, now)
    if (!sameSnapshot(current, next)) {
      await this.deps.breakers.write(channelId, next)
    }
    return next
  }
}

function sameSnapshot(a: BreakerSnapshot, b: BreakerSnapshot): boolean {
  return (
    a.state === b.state &&
    a.openedAt === b.openedAt &&
    a.probeSuccess === b.probeSuccess
  )
}
