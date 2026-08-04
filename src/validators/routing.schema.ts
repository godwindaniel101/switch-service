import { z } from 'zod'

/**
 * THE INBOUND SIDE OF THE CONTRACT.
 *
 * disbursement-service published a pact that says what it sends to `/route`.
 * `npm run pact:provider` replays it against a real instance of this service,
 * so a change here can break a different repository.
 *
 * Before you make a field stricter, read the pact-contract-testing skill. The
 * order of work is: change the consumer test, publish, change this schema,
 * verify.
 */
export const routeRequestSchema = z.object({
  transactionId: z.string().min(1).max(64),
  amountMinor: z.number().int().positive(),
  currency: z.string().length(3),
  corridor: z.string().min(3).max(32),
  bankCode: z.string().min(3).max(10),
  requestedAt: z.string().min(1),
  /**
   * The channels that the CALLER can actually reach.
   *
   * The switch keeps its channel list in its own database. The caller keeps its
   * rail adapters in its own code. Nothing keeps the two in step, so without
   * this field the switch can answer with a channel that the caller cannot use.
   *
   * Optional on purpose. A caller that is older than this contract sends
   * nothing, and this service must still answer it. Absent means "no limit",
   * which is exactly the behaviour before the field existed.
   */
  supportedChannels: z.array(z.string().min(1)).min(1).optional(),
})

export type RouteRequestBody = z.infer<typeof routeRequestSchema>

export const listQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).default(20),
})

export const sinceQuerySchema = z.object({
  since: z.string().min(1).optional(),
})

export const setEnabledSchema = z.object({
  enabled: z.boolean(),
})

export const clockSchema = z.object({
  advanceMs: z
    .number()
    .int()
    .min(0)
    .max(24 * 60 * 60 * 1_000),
})

export const seedSchema = z.object({
  channels: z
    .array(
      z.object({
        id: z.string().min(1).max(32),
        name: z.string().min(1).max(64),
        cost: z.number().min(0),
        enabled: z.boolean().optional(),
      }),
    )
    .optional(),
})
