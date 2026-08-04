import type { Request, Response } from 'express'
import type { HealthService } from '../services/healthService'

/**
 *   /health/live   Is the process alive?   A failure means: restart it.
 *   /health/ready  Can it serve traffic?   A failure means: take it out.
 */
export class HealthController {
  constructor(private readonly health: HealthService) {}

  live = async (_req: Request, res: Response): Promise<void> => {
    res.json(this.health.liveness())
  }

  ready = async (_req: Request, res: Response): Promise<void> => {
    const report = await this.health.readiness()
    res.status(report.ready ? 200 : 503).json({
      status: report.ready ? 'ready' : 'not-ready',
      dependencies: report.dependencies,
      routing: this.health.routingSummary(),
    })
  }

  simple = async (_req: Request, res: Response): Promise<void> => {
    res.json({ status: this.health.isReady ? 'ready' : 'starting' })
  }
}
