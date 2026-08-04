import { db, dbRead } from '../db/pool'
import type { Candidate, RoutingDecision } from '../domain/types'

/**
 * The decision log. It answers the only question an operator asks during an
 * incident: why did this payout go there?
 */

interface Row {
  id: string
  transaction_id: string
  channel_id: string
  strategy: string
  window_ms: number
  candidates: Candidate[]
  evaluated_at: Date
}

export async function insertDecision(
  decision: RoutingDecision,
  transactionId: string,
): Promise<void> {
  await db.query(
    `INSERT INTO routing_decisions
       (id, transaction_id, channel_id, strategy, window_ms, candidates, evaluated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO NOTHING`,
    [
      decision.decisionId,
      transactionId,
      decision.channelId,
      decision.strategy,
      decision.windowMs,
      JSON.stringify(decision.candidates),
      decision.evaluatedAt,
    ],
  )
}

export interface DecisionRecord {
  decisionId: string
  transactionId: string
  channelId: string
  strategy: string
  windowMs: number
  candidates: Candidate[]
  evaluatedAt: string
}

export async function listRecentDecisions(limit = 20): Promise<DecisionRecord[]> {
  const capped = Math.min(Math.max(limit, 1), 200)
  const result = await dbRead.query<Row>(
    `SELECT id, transaction_id, channel_id, strategy, window_ms, candidates, evaluated_at
       FROM routing_decisions
      ORDER BY evaluated_at DESC
      LIMIT $1`,
    [capped],
  )
  return result.rows.map((row) => ({
    decisionId: row.id,
    transactionId: row.transaction_id,
    channelId: row.channel_id,
    strategy: row.strategy,
    windowMs: row.window_ms,
    candidates: row.candidates,
    evaluatedAt: row.evaluated_at.toISOString(),
  }))
}

/** The share of decisions for each channel and each strategy. */
export async function decisionShare(sinceIso: string): Promise<
  Array<{ channelId: string; strategy: string; count: number }>
> {
  const result = await dbRead.query<{
    channel_id: string
    strategy: string
    count: string
  }>(
    `SELECT channel_id, strategy, COUNT(*) AS count
       FROM routing_decisions
      WHERE evaluated_at >= $1
      GROUP BY channel_id, strategy
      ORDER BY channel_id, strategy`,
    [sinceIso],
  )
  return result.rows.map((r) => ({
    channelId: r.channel_id,
    strategy: r.strategy,
    count: Number(r.count),
  }))
}

/** Used by the harness between scenarios. */
export async function truncateDecisions(): Promise<void> {
  await db.query('TRUNCATE routing_decisions')
}
