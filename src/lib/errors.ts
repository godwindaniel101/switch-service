/**
 * Typed errors. Each error carries the wire contract: the HTTP code, the
 * machine readable type and the message.
 *
 * Rule: a subclass never changes the HTTP code of its parent. A class named
 * for one HTTP code that extends a parent with a different code breaks every
 * client that reads the code.
 *
 * The values here are part of the pact with disbursement-service. Do not
 * rename an errorType to make it read better.
 */
export abstract class AppError extends Error {
  abstract readonly httpCode: number
  abstract readonly errorType: string

  constructor(
    message: string,
    readonly context: Record<string, unknown> = {},
    options?: { cause?: unknown },
  ) {
    super(message, options as ErrorOptions)
    this.name = new.target.name
    Error.captureStackTrace?.(this, new.target)
  }

  toWire(): { error: true; errorType: string; message: string } {
    return { error: true, errorType: this.errorType, message: this.message }
  }
}

export class BadRequestError extends AppError {
  readonly httpCode = 400
  readonly errorType: string = 'BAD_REQUEST'
}

export class ValidationError extends BadRequestError {
  override readonly errorType = 'VALIDATION_FAILED'
}

export class NotFoundError extends AppError {
  readonly httpCode = 404
  readonly errorType: string = 'NOT_FOUND'
}

export class ChannelNotFoundError extends NotFoundError {
  override readonly errorType = 'CHANNEL_NOT_FOUND'
}

export class ServiceUnavailableError extends AppError {
  readonly httpCode = 503
  readonly errorType: string = 'SERVICE_UNAVAILABLE'
}

export class DatabaseUnavailableError extends ServiceUnavailableError {
  override readonly errorType = 'DATABASE_UNAVAILABLE'
}

/**
 * Every channel is blocked or disabled.
 *
 * This is a 503 and not a 500. Nothing is broken; there is simply nothing to
 * choose. The consumer pact of disbursement-service expects this exact
 * errorType with this exact status. Changing either one is a wire break.
 */
export class NoEligibleChannelError extends ServiceUnavailableError {
  override readonly errorType = 'NO_ELIGIBLE_CHANNEL'
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError
}
