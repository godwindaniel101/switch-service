import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  api,
  DISBURSEMENT_URL,
  SWITCH_URL,
  type ChannelsResponse,
  type ContractStatus,
  type Decision,
  type LoadState,
  type RailProfile,
  type SeriesPoint,
  type SeriesResponse,
  type Transaction,
} from './api'
import { prefersDark, seriesColor, seriesRank } from './theme'
import { ChannelTiles } from './components/ChannelTiles'
import { LineChart, Legend, type Series } from './components/LineChart'
import { TransactionTable } from './components/TransactionTable'
import { DecisionTrace } from './components/DecisionTrace'
import { Controls } from './components/Controls'
import { ContractPanel } from './components/ContractPanel'

const DEFAULT_BUCKET_MS = 5_000
const DEFAULT_MIN_SAMPLES = 20
const DEFAULT_WINDOW_MS = 60_000

/**
 * The end-to-end console.
 *
 * It reads the switch for the window, the score and the decisions, and it
 * reads the disbursement service for the payouts and the controls.
 *
 * Two live feeds keep the page fresh, and a poll fills the gaps. A feed alone
 * would leave the page empty after a reload.
 */
export function App() {
  const [dark, setDark] = useState(prefersDark)
  const [channels, setChannels] = useState<ChannelsResponse | null>(null)
  const [series, setSeries] = useState<SeriesResponse | null>(null)
  const [decisions, setDecisions] = useState<Decision[]>([])
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [rails, setRails] = useState<RailProfile[]>([])
  const [load, setLoad] = useState<LoadState | null>(null)
  const [contracts, setContracts] = useState<ContractStatus | null>(null)
  const [switchUp, setSwitchUp] = useState(true)
  const [disbursementUp, setDisbursementUp] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const contractsAt = useRef(0)

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const listener = () => setDark(prefersDark())
    media.addEventListener('change', listener)
    return () => media.removeEventListener('change', listener)
  }, [])

  const refresh = useCallback(async () => {
    // The two services fail on their own. One that is down must not blank the
    // half of the page that still works.
    const [switchPart, disbursementPart] = await Promise.allSettled([
      Promise.all([api.channels(), api.series(), api.decisions(12)]),
      Promise.all([api.transactions(25), api.rails(), api.loadState()]),
    ])

    if (switchPart.status === 'fulfilled') {
      const [nextChannels, nextSeries, nextDecisions] = switchPart.value
      setChannels(nextChannels)
      setSeries(nextSeries)
      setDecisions(nextDecisions.decisions)
      setSwitchUp(true)
    } else {
      setSwitchUp(false)
    }

    if (disbursementPart.status === 'fulfilled') {
      const [nextTransactions, nextRails, nextLoad] = disbursementPart.value
      setTransactions(nextTransactions.transactions)
      setRails(nextRails.rails)
      setLoad(nextLoad)
      setDisbursementUp(true)
    } else {
      setDisbursementUp(false)
    }

    // The broker is not a hot path. Ask it every 15 seconds.
    if (Date.now() - contractsAt.current > 15_000) {
      contractsAt.current = Date.now()
      api.contracts().then(setContracts).catch(() => setContracts(null))
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 1_000)
    return () => clearInterval(timer)
  }, [refresh])

  // The live feeds. They make the page react at once, and the poll above keeps
  // the numbers exact.
  useEffect(() => {
    const sources = [
      new EventSource(`${SWITCH_URL}/events`),
      new EventSource(`${DISBURSEMENT_URL}/events`),
    ]
    return () => sources.forEach((source) => source.close())
  }, [])

  const channelList = useMemo(() => {
    const list = channels?.channels ?? []
    // Sort by rank for the eye. The COLOUR still follows the channel, never
    // the rank, so a change of order never repaints a line.
    return [...list].sort((a, b) => {
      if (a.eligible !== b.eligible) return a.eligible ? -1 : 1
      return a.rank - b.rank
    })
  }, [channels])

  // Fixed order, so the legend never moves.
  const toSeries = useCallback(
    (pick: (point: SeriesPoint) => number | null): Series[] =>
      [...(series?.series ?? [])]
        .sort((a, b) => seriesRank(a.channelId) - seriesRank(b.channelId))
        .map((entry) => ({
          id: entry.channelId,
          color: seriesColor(entry.channelId, dark),
          points: entry.points.map(pick),
        })),
    [series, dark],
  )

  const chartSeries = useMemo(() => toSeries((point) => point.successRate), [toSeries])
  const latencySeries = useMemo(() => toSeries((point) => point.p95Ms), [toSeries])

  const xLabels = useMemo(() => {
    const points = series?.series[0]?.points ?? []
    const bucketMs = series?.bucketMs ?? DEFAULT_BUCKET_MS
    const count = points.length
    return points.map((_, index) => {
      const secondsAgo = (count - 1 - index) * (bucketMs / 1_000)
      return secondsAgo === 0 ? 'now' : `${secondsAgo}s ago`
    })
  }, [series])

  const windowSeconds = Math.round((channels?.windowMs ?? DEFAULT_WINDOW_MS) / 1_000)

  return (
    <div className="shell">
      <header className="top">
        <h1>Routing console</h1>
        <span className="sub">
          disbursement asks switch for a channel · outcomes return over Redis ·
          the window holds {windowSeconds} s
        </span>
        <span className="spacer" />
        <span className={`live${switchUp ? '' : ' down'}`}>
          <span className="dot" /> switch
        </span>
        <span className={`live${disbursementUp ? '' : ' down'}`}>
          <span className="dot" /> disbursement
        </span>
        <button
          onClick={() => {
            const next = dark ? 'light' : 'dark'
            document.documentElement.dataset.theme = next
            setDark(next === 'dark')
          }}
        >
          {dark ? 'light' : 'dark'}
        </button>
      </header>

      {error && <div className="err">{error}</div>}
      {!disbursementUp && (
        <div className="err">
          the disbursement service at {DISBURSEMENT_URL} did not answer. Start it,
          or pass a different address with ?disbursement=…
        </div>
      )}

      <div className="stack">
        <ChannelTiles
          channels={channelList}
          dark={dark}
          minSamples={channels?.minSamples ?? DEFAULT_MIN_SAMPLES}
        />

        <div className="grid cols-2">
          <div className="card">
            <div className="chart-head">
              <h2>Success rate</h2>
              <span className="hint" style={{ margin: 0 }}>
                one point for each {(series?.bucketMs ?? DEFAULT_BUCKET_MS) / 1_000} s
                bucket
              </span>
            </div>
            <Legend series={chartSeries} />
            <LineChart
              series={chartSeries}
              xLabels={xLabels}
              yMin={0}
              yMax={1}
              format={(value) => `${Math.round(value * 100)}%`}
              emptyMessage="no payout in this window yet"
            />
          </div>

          <div className="card">
            <div className="chart-head">
              <h2>Latency p95</h2>
              <span className="hint" style={{ margin: 0 }}>
                a gap means the bucket held no payout
              </span>
            </div>
            <Legend series={latencySeries} />
            {/* A separate chart, never a second scale on the chart above. */}
            <LineChart
              series={latencySeries}
              xLabels={xLabels}
              format={(value) => `${Math.round(value)}`}
              emptyMessage="no latency sample in this window yet"
            />
          </div>
        </div>

        <div className="card">
          <h2>Drive it</h2>
          <p className="hint">
            Degrade a rail and watch the switch move the traffic. The breaker opens
            after {channels?.minSamples ?? DEFAULT_MIN_SAMPLES} payouts prove the
            channel is bad.
          </p>
          <Controls
            rails={rails}
            load={load}
            dark={dark}
            onChanged={() => void refresh()}
            onError={setError}
          />
        </div>

        <div className="card">
          <h2>Why each payout went where it went</h2>
          <p className="hint">
            The full candidate list of the last decisions. A routing system that
            cannot explain a choice is not operable.
          </p>
          <DecisionTrace decisions={decisions} dark={dark} />
        </div>

        <div className="card">
          <h2>Payout stream</h2>
          <p className="hint">
            The same numbers as the charts above, as text.
          </p>
          <TransactionTable transactions={transactions} dark={dark} />
        </div>

        <div className="card">
          <h2>Contracts</h2>
          <p className="hint">
            Read from the Pact Broker. A contract that nobody verified is not a
            pass.
          </p>
          <ContractPanel status={contracts} />
        </div>
      </div>
    </div>
  )
}
