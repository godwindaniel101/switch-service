/**
 * The sliding window.
 *
 * The window holds 60 seconds in 12 buckets of 5 seconds. A bucket is named
 * by an ABSOLUTE identifier: floor(now / bucketMs).
 *
 * Why absolute, and never a modulo index:
 *   A modulo index reuses the same key every cycle. The old count and the new
 *   count then mix, and a channel that failed a minute ago still looks bad.
 *   An absolute identifier gives every five seconds its own key, and Redis
 *   removes the old key by itself with a TTL.
 */

/** The bucket that holds the given moment. */
export function bucketIdAt(nowMs: number, bucketMs: number): number {
  if (bucketMs <= 0) throw new Error('bucketMs must be a positive number')
  return Math.floor(nowMs / bucketMs)
}

/** The count of buckets in one window. */
export function bucketCount(windowMs: number, bucketMs: number): number {
  if (bucketMs <= 0) throw new Error('bucketMs must be a positive number')
  return Math.max(1, Math.ceil(windowMs / bucketMs))
}

/**
 * The bucket identifiers of the window that ends now, oldest first.
 *
 * The list always has the same length. A bucket with no key holds zero, and
 * a missing key is not an error.
 */
export function windowBucketIds(
  nowMs: number,
  windowMs: number,
  bucketMs: number,
): number[] {
  const count = bucketCount(windowMs, bucketMs)
  const current = bucketIdAt(nowMs, bucketMs)
  return Array.from({ length: count }, (_, i) => current - (count - 1 - i))
}

/**
 * How long a bucket key must live.
 *
 * Twice the window. One window would remove a key that a reader still needs
 * at the edge of the window.
 */
export function bucketTtlSeconds(windowMs: number): number {
  return Math.ceil((windowMs * 2) / 1_000)
}

/** The key of one bucket of one channel. */
export function bucketKey(channelId: string, id: number): string {
  return `sw:${channelId}:${id}`
}

/** The key of the latency samples of one bucket. */
export function latencyKey(channelId: string, id: number): string {
  return `sw:${channelId}:${id}:lat`
}

export function breakerKey(channelId: string): string {
  return `breaker:${channelId}`
}

/** The lock that keeps a HALF_OPEN breaker to one probe at a time. */
export function probeLockKey(channelId: string): string {
  return `probe:${channelId}`
}

export function processedKey(eventId: string): string {
  return `processed:${eventId}`
}
