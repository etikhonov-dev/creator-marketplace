import fp from 'fastify-plugin'
import type { FastifyError } from 'fastify'
import { ZodError } from 'zod'
import { AppError } from '../errors.js'

export default fp(async (app) => {
  // Explicit generic: Fastify 5 types the handler's error as `unknown` by
  // default, so narrowing to FastifyError is what makes `error.validation`
  // readable below.
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    if (error instanceof AppError) {
      // Expected failures are logged at warn: they are user-facing outcomes,
      // not incidents, and shouldn't pollute error alerting.
      request.log.warn({ code: error.code, details: error.details }, error.message)
      return reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details },
      })
    }

    // Two distinct shapes, so two branches rather than one cast: a ZodError
    // carries `issues`, a Fastify schema failure carries `validation`. Casting
    // between them compiled only because `unknown` was in the way.
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_FAILED', message: 'Request body is invalid', details: error.issues },
      })
    }

    if (error.validation) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_FAILED', message: 'Request body is invalid', details: error.validation },
      })
    }

    // Fastify's own client errors — malformed JSON, unsupported media type,
    // payload too large — already carry the right 4xx and a stable FST_ERR_*
    // code. Falling through to the 500 below would blame the server for a
    // client mistake, log it at error level, and page someone for a bad curl.
    if (typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
      request.log.warn({ fastifyCode: error.code, statusCode: error.statusCode }, error.message)
      return reply.status(error.statusCode).send({
        error: {
          code: 'VALIDATION_FAILED',
          // Safe to echo: these messages describe the request, not internals.
          message: error.message,
          details: { fastifyCode: error.code },
        },
      })
    }

    // Anything else is a bug. Log it fully, tell the client nothing.
    request.log.error({ err: error }, 'unhandled error')
    return reply.status(500).send({
      error: { code: 'INTERNAL', message: 'Something went wrong' },
    })
  })
})
