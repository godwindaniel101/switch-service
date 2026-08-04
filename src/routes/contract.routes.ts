import { Router } from 'express'
import { asyncHandler } from '../middleware/asyncHandler'
import type { ContractController } from '../controllers/contract.controller'

/** Wiring only. The contract panel of the console reads this. */
export function contractRoutes(controller: ContractController): Router {
  const router = Router()

  router.get('/contracts/status', asyncHandler(controller.status))

  return router
}
