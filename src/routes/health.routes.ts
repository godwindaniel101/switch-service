import { Router } from 'express'
import { asyncHandler } from '../middleware/asyncHandler'
import type { HealthController } from '../controllers/health.controller'

/** Wiring only. */
export function healthRoutes(controller: HealthController): Router {
  const router = Router()

  router.get('/health/live', asyncHandler(controller.live))
  router.get('/health/ready', asyncHandler(controller.ready))
  router.get('/health', asyncHandler(controller.simple))

  return router
}
