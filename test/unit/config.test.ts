import { describe, it, expect } from 'vitest'
import { loadConfig } from '../../src/config'

/**
 * The configuration guards. Each one stops a fault that would be silent in
 * production and hard to find.
 */
describe('loadConfig', () => {
  it('gives the documented defaults', () => {
    const config = loadConfig({} as NodeJS.ProcessEnv)
    expect(config.routing.windowMs).toBe(60_000)
    expect(config.routing.bucketMs).toBe(5_000)
    expect(config.routing.minSamples).toBe(20)
    expect(config.routing.explorationRate).toBe(0.1)
    expect(config.routing.breaker.openMs).toBe(30_000)
    expect(config.routing.breaker.probesToClose).toBe(3)
  })

  it('refuses weights that do not add to one', () => {
    // A total above one puts the score outside 0 to 1, and then no threshold
    // in the system means what it says.
    expect(() =>
      loadConfig({
        WEIGHT_SUCCESS: '0.6',
        WEIGHT_LATENCY: '0.6',
        WEIGHT_COST: '0.1',
      } as NodeJS.ProcessEnv),
    ).toThrow(/add to 1\.0/)
  })

  it('accepts weights that add to one', () => {
    const config = loadConfig({
      WEIGHT_SUCCESS: '0.5',
      WEIGHT_LATENCY: '0.4',
      WEIGHT_COST: '0.1',
    } as NodeJS.ProcessEnv)
    expect(config.routing.weights.success).toBe(0.5)
  })

  it('refuses a bucket that is larger than the window', () => {
    expect(() =>
      loadConfig({ WINDOW_MS: '10000', BUCKET_MS: '20000' } as NodeJS.ProcessEnv),
    ).toThrow(/BUCKET_MS/)
  })

  it('refuses an exploration rate of one or more', () => {
    // A rate of 1 would send every payout to a channel that is not the best.
    expect(() =>
      loadConfig({ EXPLORATION_RATE: '1' } as NodeJS.ProcessEnv),
    ).toThrow(/EXPLORATION_RATE/)
  })

  it('accepts an exploration rate of zero', () => {
    const config = loadConfig({ EXPLORATION_RATE: '0' } as NodeJS.ProcessEnv)
    expect(config.routing.explorationRate).toBe(0)
  })

  it('reads the replica address, and falls back to the primary', () => {
    const withReplica = loadConfig({
      DATABASE_URL: 'postgres://primary/db',
      DATABASE_READ_URL: 'postgres://replica/db',
    } as NodeJS.ProcessEnv)
    expect(withReplica.databaseReadUrl).toBe('postgres://replica/db')

    const withoutReplica = loadConfig({
      DATABASE_URL: 'postgres://primary/db',
    } as NodeJS.ProcessEnv)
    expect(withoutReplica.databaseReadUrl).toBe('postgres://primary/db')
  })

  it('refuses a port that is not a number', () => {
    expect(() => loadConfig({ PORT: 'abc' } as NodeJS.ProcessEnv)).toThrow(
      /invalid configuration/,
    )
  })
})
