import { z } from 'zod'
import { DEFAULT_ROUTING_CONFIG, type RoutingConfig } from './domain/types'

/**
 * Every number of the routing algorithm lives here, and nowhere else. A
 * number written in the middle of the maths cannot be tuned and cannot be
 * found.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4011),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().default('postgres://pact:pact@localhost:5434/switch_db'),
  DATABASE_READ_URL: z.string().optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),

  REDIS_URL: z.string().default('redis://localhost:6380'),
  OUTCOME_STREAM: z.string().default('txn.outcomes'),
  CONSUMER_GROUP: z.string().default('switch-consumers'),
  CONSUMER_NAME: z.string().default(`switch-${process.pid}`),
  DEAD_LETTER_STREAM: z.string().default('txn.outcomes.dead'),
  MAX_DELIVERIES: z.coerce.number().int().positive().default(5),
  CLAIM_MIN_IDLE_MS: z.coerce.number().int().positive().default(30_000),
  PROCESSED_TTL_SECONDS: z.coerce.number().int().positive().default(600),

  /** The budget for the Redis reads inside one routing decision. */
  METRICS_TIMEOUT_MS: z.coerce.number().int().positive().default(300),

  // The routing algorithm.
  WINDOW_MS: z.coerce.number().int().positive().default(DEFAULT_ROUTING_CONFIG.windowMs),
  BUCKET_MS: z.coerce.number().int().positive().default(DEFAULT_ROUTING_CONFIG.bucketMs),
  MAX_SAMPLES_PER_BUCKET: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_ROUTING_CONFIG.maxSamplesPerBucket),
  MIN_SAMPLES: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_ROUTING_CONFIG.minSamples),
  LATENCY_CEILING_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_ROUTING_CONFIG.latencyCeilingMs),
  WEIGHT_SUCCESS: z.coerce.number().default(DEFAULT_ROUTING_CONFIG.weights.success),
  WEIGHT_LATENCY: z.coerce.number().default(DEFAULT_ROUTING_CONFIG.weights.latency),
  WEIGHT_COST: z.coerce.number().default(DEFAULT_ROUTING_CONFIG.weights.cost),
  BREAKER_FAILURE_RATE_THRESHOLD: z.coerce
    .number()
    .default(DEFAULT_ROUTING_CONFIG.breaker.failureRateThreshold),
  BREAKER_OPEN_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_ROUTING_CONFIG.breaker.openMs),
  BREAKER_PROBES_TO_CLOSE: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_ROUTING_CONFIG.breaker.probesToClose),
  EXPLORATION_RATE: z.coerce.number().default(DEFAULT_ROUTING_CONFIG.explorationRate),
  COLD_START_SUCCESS_RATE: z.coerce
    .number()
    .default(DEFAULT_ROUTING_CONFIG.coldStart.successRate),
  COLD_START_LATENCY_SCORE: z.coerce
    .number()
    .default(DEFAULT_ROUTING_CONFIG.coldStart.latencyScore),
})

export type Config = z.infer<typeof schema> & {
  databaseReadUrl: string
  isTest: boolean
  routing: RoutingConfig
}

const WEIGHT_TOLERANCE = 1e-9

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ')
    throw new Error(`invalid configuration: ${detail}`)
  }
  const value = parsed.data

  const routing: RoutingConfig = {
    windowMs: value.WINDOW_MS,
    bucketMs: value.BUCKET_MS,
    maxSamplesPerBucket: value.MAX_SAMPLES_PER_BUCKET,
    minSamples: value.MIN_SAMPLES,
    latencyCeilingMs: value.LATENCY_CEILING_MS,
    weights: {
      success: value.WEIGHT_SUCCESS,
      latency: value.WEIGHT_LATENCY,
      cost: value.WEIGHT_COST,
    },
    breaker: {
      failureRateThreshold: value.BREAKER_FAILURE_RATE_THRESHOLD,
      openMs: value.BREAKER_OPEN_MS,
      probesToClose: value.BREAKER_PROBES_TO_CLOSE,
    },
    explorationRate: value.EXPLORATION_RATE,
    coldStart: {
      successRate: value.COLD_START_SUCCESS_RATE,
      latencyScore: value.COLD_START_LATENCY_SCORE,
    },
  }

  // The weights must add to one. If they do not, the score leaves the range
  // 0 to 1 and no threshold in the system means what it says.
  const total =
    routing.weights.success + routing.weights.latency + routing.weights.cost
  if (Math.abs(total - 1) > WEIGHT_TOLERANCE) {
    throw new Error(
      `the routing weights must add to 1.0, they add to ${total}. ` +
        'check WEIGHT_SUCCESS, WEIGHT_LATENCY and WEIGHT_COST',
    )
  }

  if (routing.bucketMs > routing.windowMs) {
    throw new Error('BUCKET_MS must not be larger than WINDOW_MS')
  }
  if (routing.explorationRate < 0 || routing.explorationRate >= 1) {
    throw new Error('EXPLORATION_RATE must be from 0 up to but not including 1')
  }

  return {
    ...value,
    databaseReadUrl: value.DATABASE_READ_URL ?? value.DATABASE_URL,
    isTest: value.NODE_ENV === 'test',
    routing,
  }
}

export const config = loadConfig()
