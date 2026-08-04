import { Router } from 'express'
import { asyncHandler } from '../middleware/asyncHandler'
import { validateBody, validateQuery } from '../middleware/validate'
import type { ChannelController } from '../controllers/channel.controller'
import {
  listQuerySchema,
  setEnabledSchema,
  sinceQuerySchema,
} from '../validators/routing.schema'

/** Wiring only. The console reads these. */
export function channelRoutes(controller: ChannelController): Router {
  const router = Router()

  router.get('/channels', asyncHandler(controller.list))
  // Before "/channels/:id/...", so ":id" cannot swallow the word "series".
  router.get('/channels/series', asyncHandler(controller.series))

  router.get('/decisions', validateQuery(listQuerySchema), asyncHandler(controller.decisions))
  router.get(
    '/decisions/share',
    validateQuery(sinceQuerySchema),
    asyncHandler(controller.decisionShare),
  )

  router.post(
    '/channels/:id/enabled',
    validateBody(setEnabledSchema),
    asyncHandler(controller.setEnabled),
  )

  return router
}
