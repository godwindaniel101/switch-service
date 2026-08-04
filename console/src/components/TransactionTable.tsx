import type { Transaction } from '../api'
import { clockOf } from '../format'
import { outcomeBadge, seriesColor } from '../theme'
import { Badge } from './Badge'

/**
 * The payout stream.
 *
 * This table is also the table view that the light-mode contrast relief needs:
 * every number that a chart draws is here as text as well.
 */
export function TransactionTable({
  transactions,
  dark,
}: {
  transactions: Transaction[]
  dark: boolean
}) {
  if (transactions.length === 0) {
    return <div className="empty">no payout yet. start the load below.</div>
  }

  return (
    <div className="scroll">
      <table>
        <thead>
          <tr>
            <th>time</th>
            <th>reference</th>
            <th>amount</th>
            <th>channel</th>
            <th>why</th>
            <th>latency</th>
            <th>result</th>
          </tr>
        </thead>
        <tbody>
          {transactions.map((txn) => {
            const badge = outcomeBadge(txn.status)
            return (
              <tr key={txn.id}>
                <td className="mono">{clockOf(txn.updatedAt)}</td>
                <td className="mono">{txn.reference}</td>
                <td>
                  {(txn.amountMinor / 100).toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}{' '}
                  {txn.currency}
                </td>
                <td>
                  {txn.channelId ? (
                    <span className="chan">
                      <span
                        className="key"
                        style={{ background: seriesColor(txn.channelId, dark) }}
                      />
                      {txn.channelId}
                    </span>
                  ) : (
                    <span className="why">not routed yet</span>
                  )}
                </td>
                <td className="why">
                  {txn.routingStrategy ?? '—'}
                  {txn.routingSource === 'fallback' && ' · switch was not reachable'}
                </td>
                <td>{txn.latencyMs === null ? '—' : `${txn.latencyMs} ms`}</td>
                <td>
                  <Badge badge={badge}>
                    {txn.errorCode ? ` · ${txn.errorCode}` : ''}
                  </Badge>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
