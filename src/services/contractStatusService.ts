import { logger } from '../lib/logger'

/**
 * A small read-only view of the Pact Broker, for the console.
 *
 * The console cannot read the broker directly: the broker sends no
 * cross-origin headers. This service asks on its behalf.
 *
 * The answer is cached for 10 seconds. The console polls, and the broker is
 * not a hot path.
 */

const BROKER_URL = (
  process.env.PACT_BROKER_BASE_URL ?? 'http://localhost:9292'
).replace(/\/+$/, '')

const PACTICIPANTS = ['disbursement-service', 'switch-service']
const CACHE_TTL_MS = 10_000

interface ContractRow {
  consumer: string
  provider: string
  consumerVersion: string | null
  providerVersion: string | null
  verified: boolean | null
  verifiedAt: string | null
}

interface ContractStatus {
  brokerUrl: string
  reachable: boolean
  checkedAt: string
  rows: ContractRow[]
  summary: { verified: number; failed: number; unknown: number }
}

let cache: { at: number; value: ContractStatus } | null = null

async function readBroker(): Promise<ContractStatus> {
  const checkedAt = new Date().toISOString()
  const rows: ContractRow[] = []
  let reachable = true

  for (const pacticipant of PACTICIPANTS) {
    const params = new URLSearchParams({
      'q[][pacticipant]': pacticipant,
      latestby: 'cvp',
      latest: 'true',
    })

    try {
      const response = await fetch(`${BROKER_URL}/matrix?${params.toString()}`, {
        headers: { accept: 'application/hal+json' },
        signal: AbortSignal.timeout(2_000),
      })
      if (!response.ok) {
        reachable = false
        continue
      }
      const body = (await response.json()) as {
        matrix?: Array<{
          consumer?: { name?: string; version?: { number?: string } }
          provider?: { name?: string; version?: { number?: string } }
          verificationResult?: { success?: boolean | null; verifiedAt?: string }
        }>
      }
      for (const entry of body.matrix ?? []) {
        const row: ContractRow = {
          consumer: entry.consumer?.name ?? 'unknown',
          provider: entry.provider?.name ?? 'unknown',
          consumerVersion: entry.consumer?.version?.number ?? null,
          providerVersion: entry.provider?.version?.number ?? null,
          verified: entry.verificationResult?.success ?? null,
          verifiedAt: entry.verificationResult?.verifiedAt ?? null,
        }
        // The matrix answers for both sides, so the same pair arrives twice.
        const already = rows.some(
          (r) =>
            r.consumer === row.consumer &&
            r.provider === row.provider &&
            r.consumerVersion === row.consumerVersion,
        )
        if (!already) rows.push(row)
      }
    } catch (error) {
      reachable = false
      logger.debug({ err: error, pacticipant }, 'could not read the broker')
    }
  }

  return {
    brokerUrl: BROKER_URL,
    reachable,
    checkedAt,
    rows,
    summary: {
      verified: rows.filter((r) => r.verified === true).length,
      failed: rows.filter((r) => r.verified === false).length,
      // Unknown is not a pass. Nobody verified it, so nobody knows.
      unknown: rows.filter((r) => r.verified === null).length,
    },
  }
}

/**
 * The service. It owns the cache and the broker call, so the controller only
 * hands the answer back.
 */
export class ContractStatusService {
  async status(): Promise<ContractStatus> {
    const now = Date.now()
    if (cache && now - cache.at < CACHE_TTL_MS) return cache.value
    const value = await readBroker()
    cache = { at: now, value }
    return value
  }
}
