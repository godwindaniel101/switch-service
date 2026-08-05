# switch-service

Selects a payout channel from recent performance. Reads the outcome of every
payout from a Redis stream, and serves the operations console.

This is a separate git repository. It shares no code with
`disbursement-service`. The two services share only contracts, and the Pact
Broker holds the contracts.

## The console

```
http://localhost:4011/console/
```

The switch owns most of the live data, so it serves the page. The page also
reads `disbursement-service` for the payout stream and the controls. Give a
different address with `?disbursement=http://host:port`.

## How a channel is chosen

```
score = 0.6 * successRate
      + 0.3 * latencyScore
      + 0.1 * costScore
```

Every part runs from 0 to 1. A larger score is better.

| Part | Rule |
|------|------|
| successRate | `success / (success + failure)` in the window |
| latencyScore | `1 - min(p95 / 2000 ms, 1)` |
| costScore | The cheapest channel scores 1, the dearest scores 0 |

### The window

60 seconds, in 12 buckets of 5 seconds. A bucket key holds an **absolute**
identifier, `floor(now / 5000)`, and Redis removes it with a TTL.

A modulo index would reuse the same key one window later, and a channel that
failed a minute ago would still look bad.

### Cold start

A channel with fewer than 20 payouts in the window has no reliable rate. The
score then uses an optimistic default of 0.8. An optimistic default lets a new
channel earn traffic. A pessimistic default starves it forever.

With fewer than 5 latency samples the p95 is `null`, not a number. A p95 from
two values is a guess, and a guess that looks like a measurement is worse than
no measurement.

### The circuit breaker

```
CLOSED     --success rate below 0.5 over 20 or more payouts-->  OPEN
OPEN       --after 30 seconds-->                                HALF_OPEN
HALF_OPEN  --3 good probes-->                                   CLOSED
HALF_OPEN  --1 failed probe-->                                  OPEN
```

A half-open breaker allows ONE payout at a time. A Redis lock holds the slot.
Without the lock, a burst of 50 payouts all pour into a rail that is still
broken.

### Exploration

10 percent of payouts go to a channel that is not the best. Without it, a
channel that recovers gets no traffic, its window stays empty, and it never
proves that it is healthy again.

Exploration never reaches a channel whose breaker is `OPEN`.

## Run it

```bash
cp .env.example .env
npm install
npm run migrate
npm run console:build
npm run dev            # or: npm run build && npm start
```

The infrastructure must run first. Start it from `platform-infra`:

```bash
cd ../platform-infra && docker compose up -d
```

## The endpoints

| Method | Path | Use |
|--------|------|-----|
| POST | `/route` | **The contract.** Choose a channel |
| GET | `/channels` | Health and score of each channel |
| GET | `/channels/series` | One point for each bucket, for the charts |
| POST | `/channels/:id/enabled` | Turn a channel on or off |
| GET | `/decisions` | The recent decisions, with the full candidate list |
| GET | `/contracts/status` | A read-only view of the Pact Broker |
| GET | `/events` | The live feed for the console |
| GET | `/health/live` `/health/ready` | Liveness and readiness |
| POST | `/internal/clock` | Move the test clock. Only when `NODE_ENV=test` |
| POST | `/internal/reset` `/internal/seed` | For the harness. Never in production |
| GET | `/internal/dump` | The state, for a failing scenario |

## The decision record

Every decision returns the full reason, not only the channel:

```json
{
  "decisionId": "dec_…", "channelId": "RAIL-A", "strategy": "best",
  "windowMs": 60000, "evaluatedAt": "…",
  "candidates": [
    { "channelId": "RAIL-A", "rank": 1, "score": 0.94, "successRate": 0.98,
      "p95Ms": 240, "costScore": 0.8, "breakerState": "CLOSED",
      "samples": 120, "coldStart": false, "eligible": true,
      "ineligibleReason": null }
  ]
}
```

**The record is the product.** A routing system that cannot explain a choice is
not operable.

## The contracts

This repository is a **provider** in one pair and a **consumer** in the other.

| Pair | Role | File |
|------|------|------|
| HTTP `/route` | provider | `test/pact/switch.provider.pact.test.ts` |
| The outcome event | consumer | `test/pact/outcome.message.consumer.pact.test.ts` |

```bash
npm run pact:consumer        # writes ./pacts
npm run pact:publish         # sends them to the broker
npm run pact:provider        # verifies /route against the broker
npm run pact:can-i-deploy    # the gate
```

The provider test reads the contract FROM THE BROKER. There is no pact file in
this repository for that pair, and there must never be one. A checked-in copy
goes stale, and the test then passes while the real consumer breaks.

## The deploy pipeline

```
test  ->  contract-gate  ->  deploy
```

`deploy` depends on `contract-gate`. **That single dependency is the whole
point.** Without it the gate is a report that nobody reads.

The gate is one script, so it runs the same way on a laptop and in the
pipeline:

```bash
export PACT_BROKER_BASE_URL=http://localhost:9292
export PACT_BROKER_USERNAME=pact PACT_BROKER_PASSWORD=pact
bash ci/contract-gate.sh
```

The script does four steps:

1. Run the consumer tests, which write `./pacts`.
2. Publish them to the broker, under this git commit.
3. Verify the contracts that this service PROVIDES.
4. Ask `can-i-deploy`. This step is the gate.

The pipeline is `.github/workflows/ci.yml`.

A GitLab version existed alongside it for a while. It was deleted: two live
pipeline files drift apart, and then nobody knows which one is the real gate.
If you ever move to GitLab, port `ci/contract-gate.sh` — the gate itself is a
shell script on purpose, so the pipeline file stays thin.

### What the pipeline needs

| Secret | Value |
|--------|-------|
| `PACT_BROKER_BASE_URL` | The address of the shared broker |
| `PACT_BROKER_USERNAME` | The broker user |
| `PACT_BROKER_PASSWORD` | The broker password |

The broker is **one long-lived shared service**. Never start it inside the
pipeline. A fresh broker is empty, `can-i-deploy` then compares this version
against nothing, and the gate says yes to everything.

### The webhook is not optional

The broker must call this repository when `disbursement-service` publishes a new
contract. Set it up once from `platform-infra`:

```bash
CI_PLATFORM=github GITHUB_OWNER=<org> GITHUB_TOKEN=<token> \
  node scripts/create-webhooks.mjs
```

Without the webhook, a change in the other repository is silent until the next
build here, and `can-i-deploy` answers "unknown" forever. Unknown is not a
pass, so somebody will switch the gate off. That is how the safety is lost.

### After a deploy

```bash
PACT_ENVIRONMENT=production npm run pact:record-deployment
```

Without this record, "can-i-deploy against production" does not know what
production runs.

## Tests

```bash
npm run test:unit           # fast, no docker
npm run test:integration    # needs redis
npm test                    # everything in this repository
npm run typecheck
```

The end-to-end scenarios live in `platform-infra`.

## Rules that this service keeps

- It never routes to a channel whose breaker is `OPEN`, for any reason.
- It never returns `NaN` as a score. Every division is guarded.
- It never fails a payout because the metrics are missing. With no metrics it
  picks the first eligible channel and marks the strategy `degraded`.
- The maths is pure. `src/domain/` reads no clock, no Redis and no
  configuration file. Every function takes `now` as an argument, and that is
  why every unit test is exact.
- Every number of the algorithm lives in the configuration. The weights must
  add to 1.0, and the service refuses to start if they do not.
