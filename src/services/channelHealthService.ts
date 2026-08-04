import { config } from '../config'
import { buildCandidates } from '../domain/scoring'
import { openForMs } from '../domain/breaker'
import { p95 } from '../domain/percentile'
import type { BreakerState } from '../domain/types'
import type { Clock } from '../lib/ports'
import type { WindowStore } from '../store/windowStore'
import type { BreakerStore } from '../store/breakerStore'
import * as channelRepository from '../repositories/channelRepository'
import * as decisionRepository from '../repositories/decisionRepository'

/**
 * The read side of the routing state.
 *
 * THIS CLASS EXISTS BECAUSE OF A DEFECT. The channel route used to import
 * `buildCandidates` and score the channels inside the HTTP handler. That put
 * the domain in the transport layer: the same maths existed in two places, and
 * only one of them was covered by the routing tests.
 *
 * Now the scoring is called from exactly two services, and a route calls
 * neither the domain nor a store.
 */

export interface ChannelHealthView {
  id: string
  name: string
  cost: number
  enabled: boolean
  score: number
  rank: number
  successRate: number
  p95Ms: number | null
  costScore: number
  samples: number
  coldStart: boolean
  eligible: boolean
  ineligibleReason: string | null
  success: number
  failure: number
  breakerState: BreakerState
  breakerOpenForMs: number | null
  probeSuccess: number
}

export interface ChannelHealthReport {
  windowMs: number
  bucketMs: number
  minSamples: number
  evaluatedAt: string
  channels: ChannelHealthView[]
}

export interface SeriesPoint {
  startMs: number
  success: number
  failure: number
  successRate: number | null
  p95Ms: number | null
}

export class ChannelHealthService {
  constructor(
    private readonly windows: WindowStore,
    private readonly breakers: BreakerStore,
    private readonly clock: Clock,
  ) {}

  /** Health and score of every channel, as the console shows them. */
  async report(): Promise<ChannelHealthReport> {
    const now = this.clock.now()
    const channels = await channelRepository.listChannels()
    const ids = channels.map((c) => c.id)
    const stats = await this.windows.readMany(ids, now)
    const breakerStates = await this.breakers.readMany(ids)
    const candidates = buildCandidates(channels, stats, breakerStates, config.routing)

    return {
      windowMs: config.routing.windowMs,
      bucketMs: config.routing.bucketMs,
      minSamples: config.routing.minSamples,
      evaluatedAt: new Date(now).toISOString(),
      channels: channels.map((channel) => {
        const candidate = candidates.find((c) => c.channelId === channel.id)
        const stat = stats.get(channel.id)
        const breaker = breakerStates.get(channel.id)
        return {
          id: channel.id,
          name: channel.name,
          cost: channel.cost,
          enabled: channel.enabled,
          score: candidate?.score ?? 0,
          rank: candidate?.rank ?? 0,
          successRate: candidate?.successRate ?? 0,
          p95Ms: candidate?.p95Ms ?? null,
          costScore: candidate?.costScore ?? 0,
          samples: candidate?.samples ?? 0,
          coldStart: candidate?.coldStart ?? true,
          eligible: candidate?.eligible ?? false,
          ineligibleReason: candidate?.ineligibleReason ?? null,
          success: stat?.success ?? 0,
          failure: stat?.failure ?? 0,
          breakerState: breaker?.state ?? 'CLOSED',
          breakerOpenForMs: breaker ? openForMs(breaker, now) : null,
          probeSuccess: breaker?.probeSuccess ?? 0,
        }
      }),
    }
  }

  /** One point for each bucket, for the charts of the console. */
  async series(): Promise<{
    windowMs: number
    bucketMs: number
    series: Array<{ channelId: string; points: SeriesPoint[] }>
  }> {
    const now = this.clock.now()
    const channels = await channelRepository.listChannels()

    const series = await Promise.all(
      channels.map(async (channel) => {
        const buckets = await this.windows.readBuckets(channel.id, now)
        return {
          channelId: channel.id,
          points: buckets.map((bucket) => {
            const total = bucket.success + bucket.failure
            return {
              startMs: bucket.startMs,
              success: bucket.success,
              failure: bucket.failure,
              // A bucket with no payout has NO rate. `null` draws a gap, and a
              // gap is the truth. A zero would draw a fall that never happened.
              successRate: total === 0 ? null : bucket.success / total,
              // One sample is enough for a chart point, unlike the routing
              // p95, which needs five. A chart shows a shape; a decision needs
              // evidence.
              p95Ms: p95(bucket.samples, 1),
            }
          }),
        }
      }),
    )

    return {
      windowMs: config.routing.windowMs,
      bucketMs: config.routing.bucketMs,
      series,
    }
  }

  async recentDecisions(limit: number): Promise<decisionRepository.DecisionRecord[]> {
    return decisionRepository.listRecentDecisions(limit)
  }

  /** The share of decisions for each channel and each strategy. */
  async decisionShare(since?: string): Promise<{
    since: string
    total: number
    rows: Array<{ channelId: string; strategy: string; count: number; share: number }>
  }> {
    const from =
      since ?? new Date(this.clock.now() - config.routing.windowMs).toISOString()
    const rows = await decisionRepository.decisionShare(from)
    const total = rows.reduce((sum, row) => sum + row.count, 0)
    return {
      since: from,
      total,
      rows: rows.map((row) => ({
        ...row,
        // Guard the division. With no decisions the share is 0, never NaN.
        share: total === 0 ? 0 : row.count / total,
      })),
    }
  }
}
