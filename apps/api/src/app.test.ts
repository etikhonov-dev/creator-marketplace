import { describe, it, expect } from 'vitest'
import { buildApp } from './app.js'
import type { ApiConfig } from './config.js'
import type { Database } from '@marketplace/db'

/**
 * A stub is enough here: these tests are about the middleware contract — who
 * the request is, what a failure looks like, whether the dev flag fails safe —
 * not about SQL. `select` resolves empty so an unknown creator id 404s.
 */
const stubDb = {
  execute: async () => [],
  select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
  // The dev route updates a deadline; returning no rows exercises its 404 path.
  update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
} as unknown as Database

const config = (o: Partial<ApiConfig> = {}): ApiConfig => ({
  DATABASE_URL: 'x', PORT: 0, LOG_LEVEL: 'silent', ENABLE_DEV_TOOLS: false, ...o,
})

/**
 * Registers a route that exists only for this suite, so the identity contract
 * is tested against the *plugin* rather than against whichever product route
 * happens to exist. The creator-context plugin is registered with
 * fastify-plugin, so its preHandler applies to routes added at the root.
 */
function appWithProbe(cfg: ApiConfig = config()) {
  const app = buildApp({ db: stubDb, config: cfg })
  app.get('/probe', async (request) => ({ creatorId: request.creator.id }))
  return app
}

describe('app middleware', () => {
  it('serves health without a creator header', async () => {
    const app = buildApp({ db: stubDb, config: config() })
    const res = await app.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok', database: 'ok' })
    await app.close()
  })

  it('echoes an inbound x-request-id so a trace spans browser and server', async () => {
    const app = buildApp({ db: stubDb, config: config() })
    const res = await app.inject({
      method: 'GET', url: '/api/health', headers: { 'x-request-id': 'trace-abc' },
    })
    expect(res.headers['x-request-id']).toBe('trace-abc')
    await app.close()
  })

  it('generates a request id when the client sends none', async () => {
    const app = buildApp({ db: stubDb, config: config() })
    const res = await app.inject({ method: 'GET', url: '/api/health' })
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/)
    await app.close()
  })

  it('rejects an identity-requiring route with no header', async () => {
    const app = appWithProbe()
    const res = await app.inject({ method: 'GET', url: '/probe' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('CREATOR_REQUIRED')
    await app.close()
  })

  it('404s an unknown creator id rather than proceeding anonymously', async () => {
    const app = appWithProbe()
    const res = await app.inject({
      method: 'GET', url: '/probe',
      headers: { 'x-creator-id': '11111111-1111-4111-8111-111111111111' },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('CREATOR_NOT_FOUND')
    await app.close()
  })

  // The flag must fail in the safe direction, and the default is false.
  it('404s the dev route when dev tools are disabled', async () => {
    const app = buildApp({ db: stubDb, config: config() })
    const res = await app.inject({
      method: 'POST', url: '/api/dev/campaigns/00000000-0000-4000-8000-000000000000/expire',
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  // Found in compose: a malformed body was being logged as 'unhandled error'
  // and answered with a 500, even though Fastify's own FST_ERR_CTP_INVALID_JSON_BODY
  // already carries statusCode 400.
  it('answers a malformed JSON body with 400, not 500', async () => {
    const app = buildApp({ db: stubDb, config: config({ ENABLE_DEV_TOOLS: true }) })
    const res = await app.inject({
      method: 'POST',
      url: '/api/dev/campaigns/00000000-0000-4000-8000-000000000000/expire',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('VALIDATION_FAILED')
    expect(res.json().error.details.fastifyCode).toBe('FST_ERR_CTP_INVALID_JSON_BODY')
    await app.close()
  })

  // Found while walking the README demo with a non-curl HTTP client: a bodyless
  // POST that sets Content-Length: 0 without a Content-Type was answered 415.
  it('accepts a bodyless POST however the client frames it', async () => {
    const app = buildApp({ db: stubDb, config: config({ ENABLE_DEV_TOOLS: true }) })
    const url = '/api/dev/campaigns/00000000-0000-4000-8000-000000000000/expire'

    const identity = { 'x-creator-id': 'c-1' }
    // No content headers at all — what browser fetch() and `curl -X POST` send.
    const bare = await app.inject({ method: 'POST', url, headers: identity })
    // Content-Length: 0 with no Content-Type — what many HTTP clients send.
    const zeroLength = await app.inject({
      method: 'POST', url, headers: { ...identity, 'content-length': '0' }, payload: '',
    })

    // Both must fail for the SAME reason — the stub resolves no creator, so
    // both stop at the identity hook. What matters is that neither is rejected
    // at the content-type layer with a 415.
    expect(bare.statusCode).toBe(404)
    expect(bare.json().error.code).toBe('CREATOR_NOT_FOUND')
    expect(zeroLength.statusCode).toBe(404)
    expect(zeroLength.json().error.code).toBe('CREATOR_NOT_FOUND')
    await app.close()
  })

  it('still rejects an unknown content type that carries an actual body', async () => {
    const app = buildApp({ db: stubDb, config: config({ ENABLE_DEV_TOOLS: true }) })
    const res = await app.inject({
      method: 'POST',
      url: '/api/dev/campaigns/00000000-0000-4000-8000-000000000000/expire',
      headers: { 'x-creator-id': 'c-1', 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'a=1',
    })
    expect(res.statusCode).toBe(415)
    await app.close()
  })

  it('registers the dev route only when explicitly enabled', async () => {
    const app = buildApp({ db: stubDb, config: config({ ENABLE_DEV_TOOLS: true }) })
    await app.ready()
    // Present in the router — not a 404 from a missing route. It still needs a
    // creator header, which is what proves it went through the same pipeline.
    const res = await app.inject({
      method: 'POST', url: '/api/dev/campaigns/00000000-0000-4000-8000-000000000000/expire',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('CREATOR_REQUIRED')
    await app.close()
  })
})
