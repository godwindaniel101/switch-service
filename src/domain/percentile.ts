/**
 * The percentile of the latency samples in the window.
 *
 * With too few samples the answer is `null`, not a number. A p95 taken from
 * two values is a guess, and a guess that looks like a measurement is worse
 * than no measurement.
 */

export const MIN_SAMPLES_FOR_PERCENTILE = 5

export function percentile(
  samples: readonly number[],
  fraction: number,
  minSamples: number = MIN_SAMPLES_FOR_PERCENTILE,
): number | null {
  if (fraction <= 0 || fraction > 1) {
    throw new Error(`fraction must be above 0 and at most 1, got ${fraction}`)
  }

  // Keep only the values that can be a latency. A NaN or a negative number
  // comes from damaged data, and it must not move the answer.
  const clean = samples.filter((v) => Number.isFinite(v) && v >= 0)
  if (clean.length < minSamples) return null

  // Sort a copy. The caller keeps its own order.
  const sorted = [...clean].sort((a, b) => a - b)
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1),
  )
  return sorted[index] as number
}

export function p95(
  samples: readonly number[],
  minSamples: number = MIN_SAMPLES_FOR_PERCENTILE,
): number | null {
  return percentile(samples, 0.95, minSamples)
}
