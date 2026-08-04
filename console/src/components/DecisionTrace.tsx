import type { Decision } from '../api'
import { clockOf } from '../format'
import { breakerBadge, seriesColor } from '../theme'

/**
 * Why each payout went where it went.
 *
 * A routing system that cannot explain a choice is not operable. This panel is
 * the reason the decision record carries the full candidate list.
 */
export function DecisionTrace({
  decisions,
  dark,
}: {
  decisions: Decision[]
  dark: boolean
}) {
  if (decisions.length === 0) {
    return <div className="empty">no routing decision yet</div>
  }

  return (
    <div className="scroll">
      <table>
        <thead>
          <tr>
            <th>time</th>
            <th>chose</th>
            <th>strategy</th>
            <th>the candidates it compared</th>
          </tr>
        </thead>
        <tbody>
          {decisions.map((decision) => (
            <tr key={decision.decisionId}>
              <td className="mono">{clockOf(decision.evaluatedAt)}</td>
              <td>
                <span className="chan">
                  <span
                    className="key"
                    style={{ background: seriesColor(decision.channelId, dark) }}
                  />
                  {decision.channelId}
                </span>
              </td>
              <td className="why">{explain(decision.strategy)}</td>
              <td className="wrap why">
                {decision.candidates.map((candidate, index) => {
                  const badge = breakerBadge(candidate.breakerState)
                  return (
                    <span key={candidate.channelId}>
                      {index > 0 && '  ·  '}
                      <span
                        className="key"
                        style={{
                          background: seriesColor(candidate.channelId, dark),
                          display: 'inline-block',
                          width: 7,
                          height: 7,
                          borderRadius: 2,
                          marginRight: 4,
                        }}
                      />
                      {candidate.channelId} {candidate.score.toFixed(3)}
                      {!candidate.eligible && (
                        <>
                          {' '}
                          <span style={{ color: badge.color }}>{badge.glyph}</span>{' '}
                          {candidate.ineligibleReason}
                        </>
                      )}
                      {candidate.coldStart && candidate.eligible && ' cold'}
                    </span>
                  )
                })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** The word that the wire uses, said in full. */
function explain(strategy: string): string {
  switch (strategy) {
    case 'best':
      return 'best score'
    case 'explore':
      return 'exploring, to keep the window fresh'
    case 'only-candidate':
      return 'the only channel available'
    case 'degraded':
      return 'degraded, the metrics were not readable'
    default:
      return strategy
  }
}
