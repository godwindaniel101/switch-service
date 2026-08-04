import { Router } from 'express'
import { asyncHandler } from '../middleware/asyncHandler'
import { validateBody } from '../middleware/validate'
import type { RoutingController } from '../controllers/routing.controller'
import { routeRequestSchema } from '../validators/routing.schema'

/**
 * THE CONTRACT ENDPOINT.
 *
 * disbursement-service depends on this path, this method and this response
 * shape. Read the pact-contract-testing skill before you change any of them.
 */
export function routingRoutes(controller: RoutingController): Router {
  const router = Router()

  router.post(
    '/route',
    validateBody(routeRequestSchema),
    asyncHandler(controller.route),
  )

  return router
}
