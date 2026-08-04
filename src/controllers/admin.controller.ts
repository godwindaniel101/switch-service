import type { Request, Response } from 'express'
import { body } from '../middleware/validate'
import type { AdminService } from '../services/adminService'
import { clockSchema, seedSchema } from '../validators/routing.schema'

/** HTTP in, HTTP out. Every guard and every order of work is in the service. */
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  advanceClock = async (req: Request, res: Response): Promise<void> => {
    const { advanceMs } = body(req, clockSchema)
    res.json(this.admin.advanceClock(advanceMs))
  }

  clockState = async (_req: Request, res: Response): Promise<void> => {
    res.json(this.admin.clockState())
  }

  reset = async (_req: Request, res: Response): Promise<void> => {
    res.json(await this.admin.reset())
  }

  seed = async (req: Request, res: Response): Promise<void> => {
    const { channels } = body(req, seedSchema)
    res.json({ channels: await this.admin.seed(channels) })
  }

  dump = async (_req: Request, res: Response): Promise<void> => {
    res.json(await this.admin.dump())
  }
}
