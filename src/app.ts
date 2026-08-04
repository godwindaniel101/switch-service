import path from 'node:path'
import { randomUUID } from 'node:crypto'
import express, { type Request, type Response, type NextFunction } from 'express'
import cors from 'cors'
import { logger } from './lib/logger'
import { isAppError } from './lib/errors'
import { events } from './lib/sse'
import { buildContainer, type Container } from './container'
import { routingRoutes } from './routes/routing.routes'
import { channelRoutes } from './routes/channel.routes'
import { adminRoutes } from './routes/admin.routes'
import { healthRoutes } from './routes/health.routes'
import { contractRoutes } from './routes/contract.routes'

export interface AppParts {
  app: express.Express
  container: Container
}

/**
 * The layers, from the outside in:
 *
 *   route       which path, which validation, which controller method
 *   middleware  validation at the boundary, and the async guard
 *   controller  HTTP in, HTTP out
 *   service     the business rules and the order of work
 *   store       Redis
 *   repository  SQL
 *   domain      pure functions, no clock and no input or output
 *
 * A layer only calls the one below it. A route that imports from `domain/` is a
 * defect even when it works: the same maths then exists in two places, and only
 * one of them is covered by the routing tests.
 */
export function createApp(): AppParts {
  const app = express()
  const container = buildContainer()

  app.disable('x-powered-by')
  app.use(cors({ origin: true, credentials: false }))
  app.use(express.json({ limit: '256kb' }))

  app.use((req: Request, res: Response, next: NextFunction) => {
    const traceId = (req.header('x-trace-id') ?? randomUUID()).slice(0, 64)
    res.locals.traceId = traceId
    res.setHeader('x-trace-id', traceId)
    next()
  })

  app.use(healthRoutes(container.controllers.health))
  app.use(routingRoutes(container.controllers.routing))
  app.use(channelRoutes(container.controllers.channels))
  app.use(adminRoutes(container.controllers.admin))
  app.use(contractRoutes(container.controllers.contracts))

  app.get('/events', (req: Request, res: Response) => {
    events.subscribe(req, res)
  })

  // The console. It is built into ./public/console by "npm run console:build".
  const consoleDir = path.resolve(__dirname, '..', 'public', 'console')
  app.use('/console', express.static(consoleDir))
  app.get('/console/*', (_req: Request, res: Response) => {
    res.sendFile(path.join(consoleDir, 'index.html'))
  })
  app.get('/', (_req: Request, res: Response) => res.redirect('/console/'))

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: true, errorType: 'NOT_FOUND', message: 'no route' })
  })

  // The error handler never changes the wire contract of a typed error. The
  // HTTP code, the errorType and the message come from the error itself,
  // because disbursement-service reads them.
  app.use((error: Error, req: Request, res: Response, _next: NextFunction) => {
    const traceId = res.locals.traceId as string | undefined
    if (isAppError(error)) {
      logger.warn(
        { err: error, traceId, errorType: error.errorType, path: req.path },
        'request failed with a known error',
      )
      res.status(error.httpCode).json({ ...error.toWire(), traceId })
      return
    }
    logger.error({ err: error, traceId, path: req.path }, 'unexpected error')
    res.status(500).json({
      error: true,
      errorType: 'INTERNAL_ERROR',
      message: 'the request could not be completed',
      traceId,
    })
  })

  return { app, container }
}
