import type { Request, Response, NextFunction, RequestHandler } from 'express'

/**
 * Passes a rejected promise to the error handler.
 *
 * Express 4 does not await a handler, so a rejection inside an async handler
 * becomes an unhandled rejection and the request hangs until it times out. The
 * client sees nothing, and for a payout that is the worst possible answer.
 *
 * Every async controller method is wrapped in this. It removes the try/catch
 * and the `next(error)` from every handler, so a missing catch cannot happen.
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next)
  }
}
