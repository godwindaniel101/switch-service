import type { Request, Response } from 'express'
import { ChannelNotFoundError } from '../lib/errors'
import { body, query } from '../middleware/validate'
import type { ChannelHealthService } from '../services/channelHealthService'
import * as channelRepository from '../repositories/channelRepository'
import {
  listQuerySchema,
  setEnabledSchema,
  sinceQuerySchema,
} from '../validators/routing.schema'

/**
 * The read endpoints of the console.
 *
 * These are not part of the pact with disbursement-service. Only the console
 * reads them, and the console ships with this service.
 */
export class ChannelController {
  constructor(private readonly health: ChannelHealthService) {}

  list = async (_req: Request, res: Response): Promise<void> => {
    res.json(await this.health.report())
  }

  series = async (_req: Request, res: Response): Promise<void> => {
    res.json(await this.health.series())
  }

  decisions = async (req: Request, res: Response): Promise<void> => {
    const { limit } = query(req, listQuerySchema)
    res.json({ decisions: await this.health.recentDecisions(limit) })
  }

  decisionShare = async (req: Request, res: Response): Promise<void> => {
    const { since } = query(req, sinceQuerySchema)
    res.json(await this.health.decisionShare(since))
  }

  setEnabled = async (req: Request, res: Response): Promise<void> => {
    const id = req.params.id as string
    const { enabled } = body(req, setEnabledSchema)
    const channel = await channelRepository.setEnabled(id, enabled)
    if (!channel) throw new ChannelNotFoundError(`no channel ${id}`)
    res.json({ channel })
  }
}
