import type { Request, Response } from 'express'
import { body } from '../middleware/validate'
import type { RoutingService } from '../services/routingService'
import { routeRequestSchema } from '../validators/routing.schema'

/**
 * The controller of the contract endpoint.
 *
 * THE SHAPE OF THIS RESPONSE IS A CONTRACT. disbursement-service published a
 * pact that says what it needs, and `npm run pact:provider` replays it against
 * a real instance of this service.
 *
 * The fields are named one by one on purpose. A spread of the internal
 * decision object would leak every new field to every consumer without anybody
 * deciding to, and a removed internal field would break the wire silently.
 */
export class RoutingController {
  constructor(private readonly routing: RoutingService) {}

  route = async (req: Request, res: Response): Promise<void> => {
    const decision = await this.routing.route(body(req, routeRequestSchema))

    res.json({
      decisionId: decision.decisionId,
      channelId: decision.channelId,
      routingStrategy: decision.strategy,
      windowMs: decision.windowMs,
      evaluatedAt: decision.evaluatedAt,
      candidates: decision.candidates.map((candidate) => ({
        channelId: candidate.channelId,
        rank: candidate.rank,
        score: candidate.score,
        successRate: candidate.successRate,
        p95Ms: candidate.p95Ms,
        costScore: candidate.costScore,
        breakerState: candidate.breakerState,
        samples: candidate.samples,
        coldStart: candidate.coldStart,
        eligible: candidate.eligible,
        ineligibleReason: candidate.ineligibleReason,
      })),
    })
  }
}
