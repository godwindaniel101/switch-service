import type { Rng } from '../domain/selection'

/**
 * Ports for the two sources of non-determinism: the clock and the random
 * source.
 *
 * The domain takes these as arguments. The domain never calls Date.now() or
 * Math.random() directly. This rule is the reason every unit test in this
 * repository is deterministic.
 */

export interface Clock {
  now(): number
  isoNow(): string
}

// Rng is declared in the domain layer. It is re-exported here, and not
// declared again, because the domain layer stays free of runtime imports.
export type { Rng }

export const systemRng: Rng = {
  next: () => Math.random(),
}

/** A clock that a test moves by hand. */
export function fixedClock(startMs: number): Clock & { advance(ms: number): void } {
  let current = startMs
  return {
    now: () => current,
    isoNow: () => new Date(current).toISOString(),
    advance: (ms: number) => {
      current += ms
    },
  }
}

/** A random source that returns a known sequence, then repeats it. */
export function sequenceRng(values: number[]): Rng {
  if (values.length === 0) throw new Error('sequenceRng needs at least one value')
  let index = 0
  return {
    next: () => {
      const value = values[index % values.length] as number
      index += 1
      return value
    },
  }
}
