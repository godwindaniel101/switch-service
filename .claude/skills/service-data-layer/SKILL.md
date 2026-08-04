---
name: service-data-layer
description: Rules for Postgres and Redis connections in each service repository. Covers the pool, the migrations, the retry on start, the health check, the graceful shutdown, the transactional outbox and the Redis stream consumer group. Use this skill when you touch a database connection, a query, a migration, a transaction, an event publication or a stream consumer. Trigger on "database", "postgres", "pool", "migration", "redis", "stream", "consumer group", "outbox", "connection", "health check", "shutdown", "idempotency".
---

# The data layer

Each service owns its own database. No service reads a table of a different
service. No service joins across a database. A service that needs data from a
different service asks over HTTP or reads an event.

| Service | Postgres database | Redis |
|---------|------------------|-------|
| `disbursement-service` | `disbursement_db` | Producer only |
| `switch-service` | `switch_db` | Window state and consumer group |

## Postgres

### One pool for each service

Make the pool once at start. Pass the pool into the repositories. Never make
a pool inside a request handler.

```ts
new Pool({
  connectionString: config.databaseUrl,
  max: 10,                        // keep it small, the money path is not a report
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000, // fail fast, do not hang the payout
  application_name: 'disbursement-service',
})
```

Set `application_name`. When the database is busy, `pg_stat_activity` then
tells you which service holds the connections.

### Separate the read pool from the write pool

Use `db` for a write and `dbRead` for a read. In local work both point at the
same database. In production they point at the primary and at the replica.
The split must exist in the code from the first day. A later split touches
every query.

Never read your own write from `dbRead`. A replica lags. After an insert,
read from `db`.

### Retry on start, fail on request

At start, the database may not be ready. Retry the first connection with a
backoff: 250 ms, 500 ms, 1 s, 2 s, 4 s, then stop and exit with code 1.

During a request, do not retry a connection. Fail fast with a 503. A retry
inside a request holds a payout open and it hides the fault.

### Every query has a timeout

```ts
await client.query('SET LOCAL statement_timeout = 5000')
```

A query with no timeout can hold a connection forever. Ten of them empty the
pool and the service stops.

### Migrations

Migrations live in `migrations/` as numbered SQL files. Run them at start,
before the server listens. Use an advisory lock so that two instances do not
run the same migration together.

```sql
SELECT pg_advisory_lock(4711);
-- run the pending migrations
SELECT pg_advisory_unlock(4711);
```

Rules for a migration:

1. A migration is forward only. To undo, write a new migration.
2. Add a column as nullable. Backfill. Then add the constraint. Three
   migrations, not one.
3. Never rename a column in one step. Add the new column, write to both, move
   the readers, then drop the old column.
4. Create an index with `CONCURRENTLY` on a table that has rows.

### Money and types

Store an amount as `BIGINT` in the minor unit. Never use `FLOAT` or `REAL`.
`0.1 + 0.2` is not `0.3` and a payment system cannot make that mistake.

Store the currency as a separate `CHAR(3)` column. An amount with no currency
is meaningless.

### Idempotency

A payout request carries a client reference. Put a unique index on it.

```sql
CREATE UNIQUE INDEX ux_transactions_reference ON transactions (reference);
```

Catch the unique violation, code `23505`. Return the existing row with the
original status. Do not return an error. A retry after a timeout is normal and
the client must get the same answer.

## The transactional outbox

The outcome event must never be lost. A write to Postgres and a write to Redis
are two different systems. They cannot share a transaction.

Therefore, write the event into an outbox table inside the same transaction as
the payout update.

```
BEGIN
  UPDATE transactions SET status = ..., latency_ms = ...
  INSERT INTO outbox (event_type, payload, created_at)
COMMIT
```

A separate publisher loop reads the unsent outbox rows, writes them to the
Redis stream, and marks them as sent. If the publisher dies, the rows stay.
When it starts again, it sends them.

Rules:

1. The payout response does not wait for the publisher. The money path never
   blocks on the metrics path.
2. The publisher marks a row as sent only after Redis confirms the write.
3. A row may go out twice. That is correct and it is safe. The consumer must
   be idempotent.
4. Order the publisher by `id`, and take a small batch, such as 100 rows.

## Redis

### Two clients, not one

A blocking read holds the connection. Therefore the consumer needs its own
client.

| Client | Use |
|--------|-----|
| `redis` | Normal commands: counters, breaker state, locks |
| `redisBlocking` | `XREADGROUP` with `BLOCK` only |

One client for both makes every counter read wait for the blocking read.

### Connection options

```ts
new Redis(url, {
  maxRetriesPerRequest: 2,
  enableReadyCheck: true,
  connectTimeout: 3_000,
  retryStrategy: (times) => Math.min(times * 200, 5_000),
})
```

Set `maxRetriesPerRequest` to a small number. The default retries forever and
it hides an outage.

### Redis is not the source of truth

Redis holds the window counters and the breaker state. Both are derived data.
If Redis loses everything, the system must still send payouts.

Therefore:

- Wrap every Redis read in the routing path with a timeout and a fallback.
- With no metrics, select the first eligible channel. Mark the decision with
  the reason `metrics-unavailable`.
- Never fail a payout because Redis is down. Log it, mark it, continue.

### The consumer group

```
stream:  txn.outcomes
group:   switch-consumers
```

Create the group with `MKSTREAM` at start. Ignore the `BUSYGROUP` error, which
means the group already exists.

Read with `XREADGROUP`. Acknowledge with `XACK` only after the handler
succeeds. A handler that throws must not acknowledge. The message then stays
pending and a later claim can retry it.

Run a claim loop for the pending messages. `XAUTOCLAIM` with a minimum idle
time of 30 seconds recovers the work of a consumer that died.

After 5 failed deliveries, move the message to a dead-letter stream and
acknowledge it. A message that can never succeed must not block the group
forever.

### Idempotent consumption

The same event can arrive twice. Keep a `SET` of the processed event ids with
a TTL of 10 minutes.

```
SET processed:{eventId} 1 NX EX 600
```

A reply of `null` means the event is a duplicate. Acknowledge it and do
nothing else. Without this guard, a replay counts one failure twice and it
opens a breaker that should stay closed.

### Trim the stream

`XADD` with `MAXLEN ~ 100000`. Without a trim the stream grows until Redis has
no memory left.

## The health check

Two endpoints, and they are not the same.

| Endpoint | Question | Failure action |
|----------|----------|----------------|
| `/health/live` | Is the process alive? | Restart the container |
| `/health/ready` | Can it serve traffic? | Take it out of the load balancer |

`ready` checks Postgres with `SELECT 1`, checks Redis with `PING`, and checks
that the migrations are complete. Give each check a 1 second timeout. A health
check that hangs is worse than a health check that fails.

Report the state of each dependency in the body. `{"postgres":"up",
"redis":"down"}` tells an operator where to look.

## Graceful shutdown

On `SIGTERM`, in this order:

1. Report `ready` as false. Wait 3 seconds so the load balancer notices.
2. Stop the HTTP server from accepting a new connection. Let the open requests
   finish, with a 10 second limit.
3. Stop the outbox publisher after the batch in flight.
4. Stop the stream consumer. Acknowledge the message in flight.
5. Close Redis. Close the pools.
6. Exit with 0. Add a hard exit timer of 15 seconds.

A service that exits at once loses the payout in flight.

## What never happens

- No query in a controller. A controller calls a service. A service calls a
  repository.
- No `SELECT *` in the code. Name the columns. A new column then cannot
  surprise the parser.
- No string concatenation in SQL. Use a parameter. Always.
- No secret in a log line. No account number in a log line.
- No `await` on the metrics path inside the payout transaction.
