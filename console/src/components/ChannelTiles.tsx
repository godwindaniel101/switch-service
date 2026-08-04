import type { ChannelHealth } from '../api'
import { breakerBadge, seriesColor } from '../theme'
import { Badge } from './Badge'

/**
 * One tile for each channel.
 *
 * The success rate is the headline, so it is a stat tile and not a chart. A
 * single number needs no plot.
 *
 * A cold channel shows no rate at all. A rate from three payouts is a guess,
 * and a guess that looks like a measurement is worse than no measurement.
 */
export function ChannelTiles({
  channels,
  dark,
  minSamples,
}: {
  channels: ChannelHealth[]
  dark: boolean
  minSamples: number
}) {
  if (channels.length === 0) {
    return <div className="empty">no channel is configured</div>
  }

  return (
    <div className="tiles">
      {channels.map((channel) => {
        const color = seriesColor(channel.id, dark)
        const badge = breakerBadge(channel.breakerState)
        const total = channel.success + channel.failure

        return (
          <div
            className={`tile${channel.eligible ? '' : ' blocked'}`}
            key={channel.id}
          >
            <span className="rail" style={{ background: color }} />

            <div className="name">
              <span className="swatch" style={{ background: color }} />
              <span className="id">{channel.id}</span>
              <span className="rank">
                {channel.eligible ? `rank ${channel.rank}` : 'not eligible'}
              </span>
            </div>

            {channel.coldStart ? (
              <div className="value unknown">
                not measured
                <span className="unit"> yet</span>
              </div>
            ) : (
              <div className="value">
                {(channel.successRate * 100).toFixed(1)}
                <span className="unit">% success</span>
              </div>
            )}

            <div className="metrics">
              <span>
                p95 <b>{channel.p95Ms === null ? '—' : `${channel.p95Ms} ms`}</b>
              </span>
              <span>
                score <b>{channel.score.toFixed(3)}</b>
              </span>
              <span>
                payouts <b>{total}</b>
              </span>
              <span>
                cost <b>{channel.cost.toFixed(2)}</b>
              </span>
            </div>

            <div className="foot">
              {/* A shape and a word travel with the colour. A breaker state is
                  never carried by colour alone. */}
              <Badge badge={{ ...badge, label: `breaker ${badge.label}` }}>
                {channel.breakerState === 'HALF_OPEN' &&
                  ` · ${channel.probeSuccess} good probes`}
              </Badge>

              {channel.coldStart && (
                <span className="chip">cold · under {minSamples}</span>
              )}
              {!channel.enabled && <span className="chip">disabled</span>}
              {channel.ineligibleReason && channel.enabled && (
                <span className="chip">{channel.ineligibleReason}</span>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
