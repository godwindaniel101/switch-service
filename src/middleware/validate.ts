import type { Request, Response, NextFunction, RequestHandler } from 'express'
import type { ZodTypeAny, z } from 'zod'
import { ValidationError } from '../lib/errors'

/**
 * Validation at the boundary, before any business logic runs.
 *
 * The middleware REPLACES `req.body` with the parsed value, so a controller
 * receives values that are already correct and already typed. A controller
 * that parses its own input ends up doing it twice, or not at all.
 */

function validateSource(
  source: 'body' | 'query',
  schema: ZodTypeAny,
  store: (req: Request, data: unknown) => void,
): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req[source])
    if (!parsed.success) {
      // One message that names every field. A caller must not have to fix one
      // field at a time.
      next(
        new ValidationError(
          parsed.error.issues
            .map((issue) => `${issue.path.join('.') || source} ${issue.message}`)
            .join('; '),
        ),
      )
      return
    }
    store(req, parsed.data)
    next()
  }
}

// Zod applies defaults and coercions, so the parsed value is not the same
// object as the input. The controller must read the parsed one.
export const validateBody = (schema: ZodTypeAny): RequestHandler =>
  validateSource('body', schema, (req, data) => {
    req.body = data
  })

export const validateQuery = (schema: ZodTypeAny): RequestHandler =>
  validateSource('query', schema, (req, data) => {
    ;(req as Request & { validatedQuery?: unknown }).validatedQuery = data
  })

/** Reads the value that `validateBody` produced, with its type. */
export function body<S extends ZodTypeAny>(req: Request, _schema: S): z.infer<S> {
  return req.body as z.infer<S>
}

/** Reads the value that `validateQuery` produced, with its type. */
export function query<S extends ZodTypeAny>(req: Request, _schema: S): z.infer<S> {
  return (req as Request & { validatedQuery: z.infer<S> }).validatedQuery
}
