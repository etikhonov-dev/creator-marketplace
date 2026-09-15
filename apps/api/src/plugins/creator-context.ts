import fp from 'fastify-plugin'
import { eq } from 'drizzle-orm'
import { creators, type Creator } from '@marketplace/db'
import { AppError } from '../errors.js'

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Populated by the preHandler below on every non-anonymous route. Typed as
     * non-optional because every route that reads it runs after that hook; the
     * hook throws rather than leaving it unset.
     */
    creator: Creator
  }
}

/** Routes that do not need to know who you are. */
const ANONYMOUS = new Set(['/api/health', '/api/creators'])

/**
 * Resolves X-Creator-Id into request.creator.
 *
 * Identity comes from exactly ONE place. The first draft of this API took the
 * creator from a :creatorId path parameter on reads and this header on writes —
 * two sources of truth, which makes a request whose path says creator A and
 * whose header says creator B representable. With one source it is not.
 *
 * This is not authentication. It is the seam where authentication attaches:
 * swap this for a plugin that reads a verified JWT and no route changes.
 */
export default fp(async (app) => {
  // Single-argument form: declares the property so every request object has the
  // same V8 shape, without seeding a value. Passing `null` here would be the
  // Fastify 4 idiom and does not typecheck against the declared `Creator`.
  app.decorateRequest('creator')

  app.addHook('preHandler', async (request) => {
    // Fastify runs root-level preHandler hooks for the not-found handler as
    // well, where routeOptions.url is undefined. Without this check every
    // unknown path answers 400 CREATOR_REQUIRED instead of 404 — hiding the
    // real problem (wrong URL) behind a misleading one (missing header), and
    // making a disabled dev route indistinguishable from an unauthenticated one.
    const url = request.routeOptions.url
    if (url === undefined || ANONYMOUS.has(url)) return

    const id = request.headers['x-creator-id']
    if (typeof id !== 'string' || id.length === 0) {
      throw new AppError('CREATOR_REQUIRED', 400, 'X-Creator-Id header is required')
    }

    const [creator] = await app.db.select().from(creators).where(eq(creators.id, id)).limit(1)
    if (!creator) throw new AppError('CREATOR_NOT_FOUND', 404, `no creator ${id}`)

    request.creator = creator
  })
})
