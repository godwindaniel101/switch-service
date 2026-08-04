import { describe, it, expect } from 'vitest'
import {
  bucketIdAt,
  bucketCount,
  windowBucketIds,
  bucketTtlSeconds,
  bucketKey,
} from '../../src/domain/window'

/**
 * The window maths. Every test gives `now` by hand, so nothing depends on the
 * real clock.
 */

const WINDOW_MS = 60_000
const BUCKET_MS = 5_000

describe('bucketIdAt', () => {
  it('gives the same identifier for every moment inside one bucket', () => {
    expect(bucketIdAt(0, BUCKET_MS)).toBe(0)
    expect(bucketIdAt(4_999, BUCKET_MS)).toBe(0)
    expect(bucketIdAt(5_000, BUCKET_MS)).toBe(1)
  })

  it('uses an absolute identifier, so a key is never reused', () => {
    // This is the reason the window is correct. A modulo index would give the
    // same key one window later, and the old count would mix with the new one.
    const first = bucketIdAt(1_000, BUCKET_MS)
    const oneWindowLater = bucketIdAt(1_000 + WINDOW_MS, BUCKET_MS)
    expect(oneWindowLater).not.toBe(first)
    expect(bucketKey('RAIL-A', first)).not.toBe(bucketKey('RAIL-A', oneWindowLater))
  })

  it('refuses a bucket size of zero', () => {
    expect(() => bucketIdAt(1_000, 0)).toThrow(/positive/)
  })
})

describe('bucketCount', () => {
  it('gives 12 buckets for a 60 second window of 5 second buckets', () => {
    expect(bucketCount(WINDOW_MS, BUCKET_MS)).toBe(12)
  })

  it('rounds up a window that does not divide evenly', () => {
    expect(bucketCount(7_000, 5_000)).toBe(2)
  })

  it('never gives fewer than one bucket', () => {
    expect(bucketCount(100, 5_000)).toBe(1)
  })
})

describe('windowBucketIds', () => {
  it('gives one identifier for each bucket, oldest first', () => {
    const ids = windowBucketIds(60_000, WINDOW_MS, BUCKET_MS)
    expect(ids).toHaveLength(12)
    expect(ids[0]).toBe(1) // 60000/5000 = 12, minus 11
    expect(ids[11]).toBe(12)
    expect(ids).toEqual([...ids].sort((a, b) => a - b))
  })

  it('drops a count out of the window after the window passes', () => {
    // The heart of "sliding". A payout at second 0 is inside the window at
    // second 59 and outside it at second 61.
    const bucketOfSecond0 = bucketIdAt(0, BUCKET_MS)

    const atSecond59 = windowBucketIds(59_000, WINDOW_MS, BUCKET_MS)
    expect(atSecond59).toContain(bucketOfSecond0)

    const atSecond61 = windowBucketIds(61_000, WINDOW_MS, BUCKET_MS)
    expect(atSecond61).not.toContain(bucketOfSecond0)
  })

  it('keeps the same length as time moves', () => {
    for (const now of [0, 12_345, 999_999, 86_400_000]) {
      expect(windowBucketIds(now, WINDOW_MS, BUCKET_MS)).toHaveLength(12)
    }
  })

  it('always ends with the bucket that holds now', () => {
    const now = 123_456
    const ids = windowBucketIds(now, WINDOW_MS, BUCKET_MS)
    expect(ids[ids.length - 1]).toBe(bucketIdAt(now, BUCKET_MS))
  })
})

describe('bucketTtlSeconds', () => {
  it('keeps a bucket for twice the window', () => {
    // One window would remove a key that a reader still needs at the edge of
    // the window.
    expect(bucketTtlSeconds(WINDOW_MS)).toBe(120)
  })
})
