import { describe, it, expect } from 'vitest'
import { percentile, p95, MIN_SAMPLES_FOR_PERCENTILE } from '../../src/domain/percentile'

describe('percentile', () => {
  it('gives an exact value for a known sample set', () => {
    const samples = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
    // ceil(0.95 * 10) - 1 = 9, so the last value.
    expect(percentile(samples, 0.95)).toBe(100)
    // ceil(0.5 * 10) - 1 = 4
    expect(percentile(samples, 0.5)).toBe(50)
  })

  it('does not depend on the order of the input', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    const shuffled = [7, 2, 10, 1, 5, 9, 3, 8, 4, 6]
    expect(percentile(shuffled, 0.95)).toBe(percentile(sorted, 0.95))
  })

  it('leaves the caller array untouched', () => {
    const samples = [5, 3, 1, 4, 2]
    percentile(samples, 0.95, 1)
    expect(samples).toEqual([5, 3, 1, 4, 2])
  })

  it('returns null with too few samples', () => {
    // A p95 from two values is a guess. A guess that looks like a measurement
    // is worse than no measurement.
    expect(p95([100, 200])).toBeNull()
    expect(p95([100, 200, 300, 400])).toBeNull()
    expect(p95([100, 200, 300, 400, 500])).not.toBeNull()
    expect(MIN_SAMPLES_FOR_PERCENTILE).toBe(5)
  })

  it('returns null for an empty set', () => {
    expect(p95([])).toBeNull()
  })

  it('ignores a value that cannot be a latency', () => {
    const samples = [100, 200, 300, 400, 500, Number.NaN, -50, Infinity]
    // Six good values remain: ceil(0.95*5)-1 = 4 of [100..500]
    expect(p95(samples)).toBe(500)
  })

  it('gives the single value when only one sample is allowed and present', () => {
    expect(percentile([42], 0.95, 1)).toBe(42)
  })

  it('never reads past the end of the array', () => {
    for (let n = 1; n <= 40; n += 1) {
      const samples = Array.from({ length: n }, (_, i) => i + 1)
      const value = percentile(samples, 1, 1)
      expect(value).toBe(n)
    }
  })

  it('refuses a fraction outside the range', () => {
    expect(() => percentile([1, 2, 3, 4, 5], 0)).toThrow(/fraction/)
    expect(() => percentile([1, 2, 3, 4, 5], 1.5)).toThrow(/fraction/)
  })
})
