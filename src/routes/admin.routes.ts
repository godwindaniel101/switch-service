import { Router } from 'express'
import { asyncHandler } from '../middleware/asyncHandler'
import { validateBody } from '../middleware/validate'
import type { AdminController } from '../controllers/admin.controller'
import { clockSchema, seedSchema } from '../validators/routing.schema'

/**
 * The endpoints that only a test uses.
 *
 * The guard is not here: the service refuses each action in production. A
 * guard in a route can be forgotten when a new route is added, and a guard in
 * the service cannot.
 */
export function adminRoutes(controller: AdminController): Router {
  const router = Router()

  router.post(
    '/internal/clock',
    validateBody(clockSchema),
    asyncHandler(controller.advanceClock),
  )
  router.get('/internal/clock', asyncHandler(controller.clockState))
  router.post('/internal/reset', asyncHandler(controller.reset))
  router.post('/internal/seed', validateBody(seedSchema), asyncHandler(controller.seed))
  router.get('/internal/dump', asyncHandler(controller.dump))

  return router
}
