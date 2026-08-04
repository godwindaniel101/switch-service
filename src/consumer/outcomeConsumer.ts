import type Redis from 'ioredis'
import { config } from '../config'
import { logger } from '../lib/logger'
import { sleep } from '../lib/sleep'
import { events } from '../lib/sse'
import { ensureConsumerGroup } from '../redis/consumerGroup'
import { OutcomeContractError, type OutcomeHandler } from './outcomeHandler'

/**
 * Reads the outcome stream with a consumer group.
 *
 * Rules from the service-data-layer skill:
 *   - XACK only after the handler succeeds. A failed message stays pending
 *     and a later claim retries it.
 *   - A claim loop recovers the work of a consumer that died.
 *   - After MAX_DELIVERIES the message goes to a dead-letter stream and gets
 *     an acknowledgement. A message that can never succeed must not block the
 *     group forever.
 */
export class OutcomeConsumer {
  private running = false
  private loop: Promise<void> | null = null
  private claimTimer: NodeJS.Timeout | null = null
  private appliedTotal = 0
  private duplicateTotal = 0
  private deadLetterTotal = 0

  constructor(
    private readonly redis: Redis,
    private readonly blocking: Redis,
    private readonly handler: OutcomeHandler,
  ) {}

  get stats(): {
    running: boolean
    appliedTotal: number
    duplicateTotal: number
    deadLetterTotal: number
  } {
    return {
      running: this.running,
      appliedTotal: this.appliedTotal,
      duplicateTotal: this.duplicateTotal,
      deadLetterTotal: this.deadLetterTotal,
    }
  }

  async start(): Promise<void> {
    await this.ensureGroup()
    this.running = true
    this.loop = this.readLoop()
    this.claimTimer = setInterval(() => void this.claimStale(), 10_000)
    this.claimTimer.unref?.()
    logger.info(
      { stream: config.OUTCOME_STREAM, group: config.CONSUMER_GROUP },
      'outcome consumer started',
    )
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.claimTimer) {
      clearInterval(this.claimTimer)
      this.claimTimer = null
    }
    // The blocking read holds a connection. Cut it, so the loop returns.
    this.blocking.disconnect()
    if (this.loop) await Promise.race([this.loop, sleep(2_000)])
    logger.info(this.stats, 'outcome consumer stopped')
  }

  private async ensureGroup(): Promise<void> {
    if (await ensureConsumerGroup(this.redis)) logger.info('consumer group created')
  }

  private async readLoop(): Promise<void> {
    while (this.running) {
      try {
        const reply = (await this.blocking.xreadgroup(
          'GROUP',
          config.CONSUMER_GROUP,
          config.CONSUMER_NAME,
          'COUNT',
          50,
          'BLOCK',
          2_000,
          'STREAMS',
          config.OUTCOME_STREAM,
          '>',
        )) as StreamReply | null

        if (!reply) continue
        for (const [, entries] of reply) {
          for (const [messageId, fields] of entries) {
            await this.process(messageId, fields)
          }
        }
      } catch (error) {
        if (!this.running) return

        // NOGROUP means the group is gone while this service kept running.
        // Redis holds derived data and runs with no persistence, so a restart
        // of Redis removes the stream and the group with it.
        //
        // Without this repair the consumer reads NOGROUP forever, no outcome
        // ever reaches the window again, and the routing slowly goes blind
        // while every health check still reports "running".
        const message = (error as Error).message ?? ''
        if (message.includes('NOGROUP')) {
          logger.warn('the consumer group is gone, making it again')
          try {
            await this.ensureGroup()
            continue
          } catch (repairError) {
            logger.error({ err: repairError }, 'could not make the group again')
          }
        }

        logger.warn({ err: error }, 'stream read failed, retrying')
        await sleep(500)
      }
    }
  }

  private async process(messageId: string, fields: string[]): Promise<void> {
    const payload = fieldValue(fields, 'payload')
    let message: unknown
    try {
      message = payload ? JSON.parse(payload) : null
    } catch (error) {
      logger.error({ err: error, messageId }, 'message payload is not JSON')
      await this.deadLetter(messageId, fields, 'payload is not JSON')
      return
    }

    try {
      const result = await this.handler.handle(message)
      if (result.status === 'applied') {
        this.appliedTotal += 1
        events.publish('outcome.applied', {
          channelId: result.channelId,
          breaker: result.breaker,
        })
      } else if (result.status === 'duplicate') {
        this.duplicateTotal += 1
      } else {
        logger.warn({ messageId, reason: result.reason }, 'outcome ignored')
      }
      await this.redis.xack(config.OUTCOME_STREAM, config.CONSUMER_GROUP, messageId)
    } catch (error) {
      if (error instanceof OutcomeContractError) {
        // A broken shape will never succeed. Retrying it wastes the group.
        // This is the failure that the message pact exists to stop, so log it
        // loudly.
        logger.error(
          { err: error, messageId },
          'CONTRACT BREAK: the outcome event does not match this consumer',
        )
        await this.deadLetter(messageId, fields, error.detail)
        return
      }
      // Do not acknowledge. The message stays pending and the claim loop
      // retries it later.
      logger.warn({ err: error, messageId }, 'outcome handler failed, leaving pending')
    }
  }

  /**
   * Recovers messages that a dead consumer left pending, and sends a message
   * that failed too many times to the dead-letter stream.
   */
  private async claimStale(): Promise<void> {
    if (!this.running) return
    try {
      const pending = (await this.redis.xpending(
        config.OUTCOME_STREAM,
        config.CONSUMER_GROUP,
        'IDLE',
        config.CLAIM_MIN_IDLE_MS,
        '-',
        '+',
        50,
      )) as Array<[string, string, number, number]> | null

      if (!pending || pending.length === 0) return

      for (const [messageId, , , deliveries] of pending) {
        if (deliveries >= config.MAX_DELIVERIES) {
          const entries = (await this.redis.xrange(
            config.OUTCOME_STREAM,
            messageId,
            messageId,
          )) as Array<[string, string[]]>
          const fields = entries[0]?.[1] ?? []
          await this.deadLetter(
            messageId,
            fields,
            `failed ${deliveries} times`,
          )
          continue
        }

        const claimed = (await this.redis.xclaim(
          config.OUTCOME_STREAM,
          config.CONSUMER_GROUP,
          config.CONSUMER_NAME,
          config.CLAIM_MIN_IDLE_MS,
          messageId,
        )) as Array<[string, string[]]>

        for (const [id, fields] of claimed) {
          await this.process(id, fields)
        }
      }
    } catch (error) {
      logger.warn({ err: error }, 'claim loop failed')
    }
  }

  private async deadLetter(
    messageId: string,
    fields: string[],
    reason: string,
  ): Promise<void> {
    try {
      await this.redis.xadd(
        config.DEAD_LETTER_STREAM,
        'MAXLEN',
        '~',
        '10000',
        '*',
        'originalId',
        messageId,
        'reason',
        reason,
        'payload',
        fieldValue(fields, 'payload') ?? '',
      )
      await this.redis.xack(config.OUTCOME_STREAM, config.CONSUMER_GROUP, messageId)
      this.deadLetterTotal += 1
      events.publish('outcome.deadLetter', { messageId, reason })
      logger.error({ messageId, reason }, 'message moved to the dead-letter stream')
    } catch (error) {
      logger.error({ err: error, messageId }, 'could not write the dead letter')
    }
  }
}

type StreamReply = Array<[string, Array<[string, string[]]>]>

function fieldValue(fields: string[], name: string): string | null {
  for (let i = 0; i < fields.length - 1; i += 2) {
    if (fields[i] === name) return fields[i + 1] as string
  }
  return null
}
