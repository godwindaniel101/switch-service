import { useState } from 'react'
import { api, type LoadState, type RailProfile } from '../api'
import { seriesColor } from '../theme'

/**
 * The controls. They degrade a rail and they drive the load.
 *
 * Filters and controls sit in one row above the charts, so the eye finds them
 * in one place.
 */
export function Controls({
  rails,
  load,
  dark,
  onChanged,
  onError,
}: {
  rails: RailProfile[]
  load: LoadState | null
  dark: boolean
  onChanged: () => void
  onError: (message: string | null) => void
}) {
  const [railId, setRailId] = useState(rails[0]?.id ?? 'RAIL-A')
  const [failureRate, setFailureRate] = useState(80)
  const [extraLatency, setExtraLatency] = useState(0)
  const [rate, setRate] = useState(20)
  const [busy, setBusy] = useState(false)

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true)
    onError(null)
    try {
      await work()
      onChanged()
    } catch (error) {
      onError((error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const chosen = rails.find((r) => r.id === railId)

  return (
    <div className="stack">
      <div>
        <div className="control-row">
          <div className="field">
            <label htmlFor="rail">rail</label>
            <select
              id="rail"
              value={railId}
              onChange={(event) => setRailId(event.target.value)}
            >
              {rails.map((rail) => (
                <option key={rail.id} value={rail.id}>
                  {rail.id}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="fail">failure %</label>
            <input
              id="fail"
              type="number"
              min={0}
              max={100}
              step={5}
              value={failureRate}
              onChange={(event) => setFailureRate(Number(event.target.value))}
            />
          </div>

          <div className="field">
            <label htmlFor="lat">extra ms</label>
            <input
              id="lat"
              type="number"
              min={0}
              max={30000}
              step={100}
              value={extraLatency}
              onChange={(event) => setExtraLatency(Number(event.target.value))}
            />
          </div>

          <button
            className="primary"
            disabled={busy}
            onClick={() =>
              run(() =>
                api.setInjection(railId, {
                  failureRate: failureRate / 100,
                  extraLatencyMs: extraLatency,
                }),
              )
            }
          >
            degrade
          </button>

          <button
            disabled={busy}
            onClick={() => run(() => api.setInjection(railId, { hardDown: true }))}
          >
            take down
          </button>

          <button
            disabled={busy}
            onClick={() =>
              run(() =>
                api.setInjection(railId, {
                  hardDown: false,
                  failureRate: null,
                  extraLatencyMs: 0,
                }),
              )
            }
          >
            repair
          </button>

          <button disabled={busy} onClick={() => run(() => api.resetRails())}>
            reset all
          </button>
        </div>

        {chosen && (
          <div className="inline-note">
            {chosen.id} now fails{' '}
            {(
              (chosen.injection.failureRate ?? chosen.failureRate) * 100
            ).toFixed(0)}
            % of payouts, adds {chosen.injection.extraLatencyMs} ms
            {chosen.injection.hardDown && ', and answers nothing at all'}. Its normal
            failure rate is {(chosen.failureRate * 100).toFixed(0)}%.
          </div>
        )}
      </div>

      <div>
        <div className="control-row">
          <div className="field">
            <label htmlFor="rate">payouts each second</label>
            <input
              id="rate"
              type="number"
              min={1}
              max={200}
              step={5}
              value={rate}
              onChange={(event) => setRate(Number(event.target.value))}
            />
          </div>

          <button
            className="primary"
            disabled={busy}
            onClick={() => run(() => api.startLoad(rate))}
          >
            {load?.running ? 'change rate' : 'start load'}
          </button>

          <button
            disabled={busy || !load?.running}
            onClick={() => run(() => api.stopLoad())}
          >
            stop load
          </button>
        </div>

        <div className="inline-note">
          {load?.running
            ? `sending ${load.ratePerSecond} each second · ${load.sentTotal} accepted · ${load.failedTotal} rejected`
            : 'the load generator is stopped'}
        </div>
      </div>

      <div className="legend">
        {rails.map((rail) => (
          <span className="item" key={rail.id}>
            <span
              className="key"
              style={{ background: seriesColor(rail.id, dark) }}
            />
            {rail.name}
          </span>
        ))}
      </div>
    </div>
  )
}
