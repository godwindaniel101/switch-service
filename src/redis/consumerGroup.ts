import type Redis from 'ioredis'
import { config } from '../config'

/**
 * Creates the group. MKSTREAM makes the stream if the producer has not
 * written anything yet. BUSYGROUP means the group is already there, and
 * that is not a fault.
 *
 * Returns true when this call made the group, false when it was already there.
 */
export async function ensureConsumerGroup(redis: Redis): Promise<boolean> {
  try {
    await redis.xgroup(
      'CREATE',
      config.OUTCOME_STREAM,
      config.CONSUMER_GROUP,
      '0',
      'MKSTREAM',
    )
    return true
  } catch (error) {
    const message = (error as Error).message ?? ''
    if (!message.includes('BUSYGROUP')) throw error
    return false
  }
}
