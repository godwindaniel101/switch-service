/**
 * The two services that the console reads.
 *
 * The switch serves this page, so its address is the page origin. The
 * disbursement service runs somewhere else, and its address can be given at
 * run time with ?disbursement=...
 */

const params = new URLSearchParams(window.location.search)

export const SWITCH_URL =
  params.get('switch') ?? window.location.origin.replace(/\/+$/, '')

export const DISBURSEMENT_URL = (
  params.get('disbursement') ?? 'http://localhost:4010'
).replace(/\/+$/, '')

export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

export interface ChannelHealth {
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

export interface ChannelsResponse {
  windowMs: number
  bucketMs: number
  minSamples: number
  evaluatedAt: string
  channels: ChannelHealth[]
}

export interface SeriesPoint {
  startMs: number
  success: number
  failure: number
  successRate: number | null
  p95Ms: number | null
}

export interface SeriesResponse {
  windowMs: number
  bucketMs: number
  series: Array<{ channelId: string; points: SeriesPoint[] }>
}

export interface Candidate {
  channelId: string
  rank: number
  score: number
  successRate: number
  p95Ms: number | null
  costScore: number
  breakerState: BreakerState
  samples: number
  coldStart: boolean
  eligible: boolean
  ineligibleReason: string | null
}

export interface Decision {
  decisionId: string
  transactionId: string
  channelId: string
  strategy: string
  windowMs: number
  candidates: Candidate[]
  evaluatedAt: string
}

export interface Transaction {
  id: string
  reference: string
  amountMinor: number
  currency: string
  status: string
  channelId: string | null
  decisionId: string | null
  routingSource: string | null
  routingStrategy: string | null
  latencyMs: number | null
  errorCode: string | null
  createdAt: string
  updatedAt: string
}

export interface RailProfile {
  id: string
  name: string
  baseLatencyMs: number
  jitterMs: number
  failureRate: number
  injection: {
    failureRate: number | null
    extraLatencyMs: number
    hardDown: boolean
  }
}

export interface LoadState {
  running: boolean
  ratePerSecond: number
  sentTotal: number
  failedTotal: number
  startedAt: string | null
}

export interface ContractStatus {
  brokerUrl: string
  reachable: boolean
  checkedAt: string
  rows: Array<{
    consumer: string
    provider: string
    consumerVersion: string | null
    providerVersion: string | null
    verified: boolean | null
    verifiedAt: string | null
  }>
  summary: { verified: number; failed: number; unknown: number }
}

/** The timeout is load bearing: a hung fetch would freeze the poll loop. */
const REQUEST_TIMEOUT_MS = 6_000

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  return (await response.json()) as T
}

async function sendJson<T>(url: string, method: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(text.slice(0, 200) || `${url} answered ${response.status}`)
  }
  return (await response.json()) as T
}

export const api = {
  channels: () => getJson<ChannelsResponse>(`${SWITCH_URL}/channels`),
  series: () => getJson<SeriesResponse>(`${SWITCH_URL}/channels/series`),
  decisions: (limit = 12) =>
    getJson<{ decisions: Decision[] }>(`${SWITCH_URL}/decisions?limit=${limit}`),
  contracts: () => getJson<ContractStatus>(`${SWITCH_URL}/contracts/status`),

  transactions: (limit = 25) =>
    getJson<{ transactions: Transaction[] }>(
      `${DISBURSEMENT_URL}/transactions?limit=${limit}`,
    ),
  rails: () => getJson<{ rails: RailProfile[] }>(`${DISBURSEMENT_URL}/simulator/rails`),
  loadState: () => getJson<LoadState>(`${DISBURSEMENT_URL}/simulator/load`),

  setInjection: (
    railId: string,
    patch: { failureRate?: number | null; extraLatencyMs?: number; hardDown?: boolean },
  ) => sendJson(`${DISBURSEMENT_URL}/simulator/rails/${railId}`, 'POST', patch),

  resetRails: () => sendJson(`${DISBURSEMENT_URL}/simulator/rails/reset`, 'POST', {}),

  startLoad: (ratePerSecond: number) =>
    sendJson<LoadState>(`${DISBURSEMENT_URL}/simulator/load`, 'POST', {
      ratePerSecond,
    }),

  stopLoad: () => sendJson<LoadState>(`${DISBURSEMENT_URL}/simulator/load`, 'DELETE'),
}
