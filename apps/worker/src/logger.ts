import pino from 'pino'

export type Logger = pino.Logger

export const createLogger = (level: string): Logger =>
  pino({ level, base: { service: 'worker' } })
