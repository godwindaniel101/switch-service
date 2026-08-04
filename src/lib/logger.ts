import pino from 'pino'
import { config } from '../config'

/**
 * One logger for the service. Every log line carries context.
 * The redaction list is not optional. An account number in a log file is a
 * data leak, and a log file travels further than a database.
 */
export const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: 'switch-service' },
  redact: {
    paths: [
      'accountNumber',
      '*.accountNumber',
      'destination.accountNumber',
      'req.headers.authorization',
      'password',
      '*.password',
      'apiKey',
      '*.apiKey',
    ],
    censor: '[redacted]',
  },
  transport:
    config.NODE_ENV === 'development'
      ? { target: 'pino/file', options: { destination: 1 } }
      : undefined,
})
