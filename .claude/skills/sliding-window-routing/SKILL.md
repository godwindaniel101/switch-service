---
name: sliding-window-routing
description: Rules for the sliding-window health metrics, the channel score, the circuit breaker and the exploration policy in switch-service. Use this skill when you change the window maths, the bucket keys, the score weights, the breaker state machine or the channel selection. Trigger on "sliding window", "routing", "channel score", "p95", "circuit breaker", "half open", "epsilon", "exploration", "bucket", "channel health".
---

# Sliding-window routing

The switch service selects a channel for each payout. The selection uses
recent performance only. This skill gives the rules for that calculation.

## The one design rule

Keep the maths pure. A pure function takes numbers and returns numbers. It
does not read Redis and it does not read the clock.

```
Redis  ->  ChannelStats[]  ->  pure score  ->  pure select  ->  decision
```

Three layers:

| Layer | File | Reads Redis | Reads the clock |
|-------|------|-------------|-----------------|
| Store | `src/store/windowStore.ts` | yes | no, it takes `now` |
| Domain | `src/domain/*.ts` | no | no, it takes `now` |
| Service | `src/service/routingService.ts` | through the store | through a clock port |

Always pass `now` as an argument. Never call `Date.now()` inside the domain.
This rule makes every test deterministic.

## The window

The window holds 60 seconds. The window has 12 buckets of 5 seconds.

```
bucketId = floor(nowMs / bucketMs)
key      = sw:{channelId}:{bucketId}
ttl      = windowMs * 2
```

Use the absolute bucket id. Do not use a modulo index. A modulo index reuses
a key and mixes old counts with new counts. The absolute id lets Redis expire
the old bucket without help.

To read the window, build the list of the last 12 bucket ids from `now`. Then
read those keys. A missing key means zero. A missing key is not an error.

### What a bucket holds

| Field | Type | Meaning |
|-------|------|---------|
| `success` | counter | Count of successful payouts |
| `failure` | counter | Count of failed payouts |
| `latSum` | counter | Sum of the latency in milliseconds |
| `lat` | list | Latency samples, capped at 200 per bucket |

The list gives the p95. Cap the list. Without a cap, one busy channel fills
the memory.

## The percentile

Sort the samples from all buckets in the window. Then take the value at
`ceil(0.95 * n) - 1`. Clamp the index into the array.

With fewer than 5 samples, do not report a p95. Report `null`. A p95 from 2
samples is a guess. The score must treat `null` as unknown, not as bad.

## The score

```
score = 0.6 * successRate
      + 0.3 * latencyScore
      + 0.1 * costScore
```

| Part | Range | Rule |
|------|-------|------|
| `successRate` | 0 to 1 | `success / (success + failure)` |
| `latencyScore` | 0 to 1 | `1 - min(p95 / latencyCeilingMs, 1)` |
| `costScore` | 0 to 1 | `1 - (cost - minCost) / (maxCost - minCost)` |

The latency ceiling is 2000 ms. A channel at or above the ceiling gets 0.

### Cold start

A channel with fewer than `minSamples` (20) payouts in the window has no
reliable rate. Give the channel the optimistic default of `0.8` for the
success rate and `0.5` for the latency score. An optimistic default lets a new
channel earn traffic. A pessimistic default starves it forever.

Mark the candidate with `coldStart: true`. The user interface shows this flag.

### Division by zero

`success + failure` can be 0. `maxCost - minCost` can be 0. Guard both. Return
the neutral value, not `NaN`. A `NaN` score sorts in a random way and the
routing becomes silent chaos.

## The circuit breaker

The breaker has three states.

```
CLOSED  --failure rate below 0.5 over 20 or more payouts-->  OPEN
OPEN    --after 30 seconds-->                                HALF_OPEN
HALF_OPEN --3 good probes-->                                 CLOSED
HALF_OPEN --1 failed probe-->                                OPEN
```

Rules:

1. Do not open the breaker with fewer than `minSamples` payouts. A channel
   with 2 failures out of 2 is not proven bad.
2. `OPEN` removes the channel from selection. It does not delete the channel.
3. `HALF_OPEN` allows one payout at a time. Use a Redis lock with a short TTL
   for the probe. Without the lock, a burst sends 100 payouts into a dead rail.
4. Store the state in Redis at `breaker:{channelId}`. Store `state`,
   `openedAt`, `probeSuccess` and `probeInFlight`.
5. The transition function is pure. It takes the current state, the stats and
   `now`. It returns the next state. Test it as a table.

## Exploration

10 percent of payouts go to a channel that is not the best channel. Without
exploration, a recovered channel gets no traffic and the window stays empty
forever.

Rules:

1. Inject the random source. Use a `Rng` port. In a test, pass a fixed
   sequence. Never call `Math.random()` in the domain.
2. Never explore into an `OPEN` channel.
3. Never explore when only one channel is available.
4. Mark the decision with `strategy: "explore"`. The user interface shows the
   reason, and an operator must be able to see why a payout went to a slower
   channel.

## The decision record

Every decision returns the full reason. Do not return only the channel id.

```ts
{
  decisionId, channelId, strategy: "best" | "explore" | "only-candidate",
  windowMs, evaluatedAt,
  candidates: [{ channelId, score, successRate, p95Ms, costScore,
                 breakerState, samples, coldStart, rank, eligible,
                 ineligibleReason }]
}
```

The record is the product. A routing system that cannot explain a choice is
not operable.

## Tests you must keep

Write these as unit tests with a fake clock and a fake random source.

| Test | What it proves |
|------|----------------|
| Bucket rotation | A count at second 0 leaves the window at second 61 |
| Bucket expiry | An old bucket id is never read |
| p95 with few samples | Returns `null`, not a guess |
| p95 exact | A known sample set gives the known value |
| Score weights | The parts add to the documented total |
| Zero guard | No `NaN` for an empty channel |
| Cold start | A new channel is eligible and marked |
| Breaker table | Every transition in both directions |
| Breaker minimum samples | 2 failures out of 2 does not open the breaker |
| Half-open single flight | The second request does not get the probe |
| Exploration rate | A fixed random sequence gives the expected split |
| Exploration safety | Never selects an `OPEN` channel |
| Tie break | Equal scores give a stable order, not a random order |

## Configuration

Keep every number in one config object. Read the values from the environment
with a default. Never write a number in the middle of the maths.

```ts
{
  windowMs: 60_000, bucketMs: 5_000, maxSamplesPerBucket: 200,
  minSamples: 20, latencyCeilingMs: 2_000,
  weights: { success: 0.6, latency: 0.3, cost: 0.1 },
  breaker: { failureRateThreshold: 0.5, openMs: 30_000, probesToClose: 3 },
  explorationRate: 0.1,
  coldStart: { successRate: 0.8, latencyScore: 0.5 },
}
```

Assert in a test that the weights add to 1.0.

## What this system must never do

- It must never route to an `OPEN` channel, for any reason.
- It must never return `NaN` or `undefined` as a score.
- It must never fail the payout because the metrics are missing. With no
  metrics, select the first eligible channel and mark the reason.
- It must never block the payout on the Redis write of the outcome. The write
  is asynchronous and it is not part of the payout result.
