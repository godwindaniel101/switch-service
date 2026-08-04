import type { ContractStatus } from '../api'
import { verifiedBadge } from '../theme'
import { Badge } from './Badge'

/**
 * The contract state, read from the Pact Broker.
 *
 * An unknown result is NOT a pass. Nobody verified that version, so nobody
 * knows. The panel says "not verified" and never shows a green mark for it.
 */
export function ContractPanel({ status }: { status: ContractStatus | null }) {
  if (!status) return <div className="empty">reading the broker…</div>

  if (!status.reachable && status.rows.length === 0) {
    return (
      <div className="empty">
        the broker at {status.brokerUrl} did not answer. start it with
        <span className="mono"> docker compose up -d pact-broker</span>
      </div>
    )
  }

  return (
    <div>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>contract</th>
              <th>consumer version</th>
              <th>provider version</th>
              <th>state</th>
            </tr>
          </thead>
          <tbody>
            {status.rows.map((row) => {
              const mark = verifiedBadge(row.verified)
              return (
                <tr key={`${row.consumer}-${row.provider}-${row.consumerVersion}`}>
                  <td className="wrap">
                    {row.consumer} <span className="why">needs</span> {row.provider}
                  </td>
                  <td className="mono">{row.consumerVersion ?? '—'}</td>
                  <td className="mono">{row.providerVersion ?? '—'}</td>
                  <td>
                    <Badge badge={mark} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="inline-note" style={{ marginTop: 10 }}>
        {status.summary.verified} verified · {status.summary.failed} failed ·{' '}
        {status.summary.unknown} not verified. The broker is the only exchange
        between the two repositories.
      </div>
    </div>
  )
}
