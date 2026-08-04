import type { Request, Response } from 'express'
import type { ContractStatusService } from '../services/contractStatusService'

/**
 * The contract panel of the console reads this.
 *
 * The console cannot read the broker directly, because the broker sends no
 * cross-origin headers. This service asks on its behalf.
 */
export class ContractController {
  constructor(private readonly contracts: ContractStatusService) {}

  status = async (_req: Request, res: Response): Promise<void> => {
    res.json(await this.contracts.status())
  }
}
