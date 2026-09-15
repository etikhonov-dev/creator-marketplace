# Creator Marketplace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working creator marketplace where creators see ranked matched campaigns, place bids, and a scheduled worker closes expired auctions and selects winners within budget — idempotently.

**Architecture:** pnpm monorepo. `packages/domain` holds all business rules as pure functions with no I/O; `packages/db` holds schema, migrations and seed. Three deployables: a Vite React SPA (static), a Fastify application server, and a worker that runs in `--once` (CronJob-shaped) or `--loop` (demo) mode. Only the worker closes auctions; correctness of the close lives in Postgres transactions and constraints, not in application discipline.

**Tech Stack:** Node 23, pnpm, TypeScript (strict), Fastify 5 + Zod, Drizzle ORM + Postgres 16, Vite + React 19 + React Router + TanStack Query + Tailwind, Vitest, Docker Compose + nginx, GitHub Actions.

**Spec:** `docs/design/2026-09-15-creator-marketplace-design.md`

## Global Constraints

- **Money is integer cents in `BIGINT`.** No float ever touches a budget or bid amount. Euro↔cent conversion happens only at the HTTP boundary (`packages/domain/src/money.ts`).
- **`packages/domain` performs no I/O.** No database, network, filesystem, or `Date.now()` calls. Time is always an injected parameter. It is the only place a business rule may live.
- **Only the worker closes auctions.** No HTTP route may invoke winner selection. `POST /api/dev/campaigns/:id/expire` mutates a deadline only.
- **Every `ORDER BY` whose result feeds a decision ends in a unique column** (`id`), so runs are reproducible.
- **`fit_score` is snapshotted onto the bid at bid time.** The closer never recomputes it.
- **TypeScript `strict: true`**, `noUncheckedIndexedAccess: true`, no `any` in committed code.
- **Fit-score constants** (verbatim): `MIN_FIT_TO_WIN = 40`, `ENGAGEMENT_CEILING = 0.08`, `AUDIENCE_BASELINE = 10_000`, `AUDIENCE_SATURATION_MULTIPLE = 10`, weights `genre 0.50 / engagement 0.30 / audience 0.20`.
- **Genre affinity** (verbatim): exact `1.0`, adjacent `0.6`, unrelated `0.2`.
- **`ENABLE_DEV_TOOLS` defaults to `false`**; only `docker-compose.yml` sets it `true`.

## File Structure

```
creator-marketplace/
├─ pnpm-workspace.yaml, package.json, tsconfig.base.json, .env.example
├─ docker-compose.yml, .dockerignore
├─ .github/workflows/ci.yml
├─ README.md
├─ docs/design/*.md
├─ packages/
│  ├─ domain/                     pure business rules, zero I/O
│  │  └─ src/{money,genre,matching,winners,index}.ts + *.test.ts
│  └─ db/                         schema is the single source of truth
│     └─ src/{schema,client,seed,fixtures}.ts, drizzle/, drizzle.config.ts
└─ apps/
   ├─ api/                        routes → services → repositories
   │  └─ src/{server,config,app}.ts, plugins/, routes/, services/, repositories/
   ├─ worker/                     owns auction closing
   │  └─ src/{main,close-auctions,run-record}.ts + *.integration.test.ts
   └─ web/                        Vite SPA, builds to static dist/
      └─ src/{main,App}.tsx, api/, state/, components/, pages/ ; nginx.conf
```

**Responsibility boundaries:** `domain` knows nothing about Postgres or HTTP. `db` knows nothing about business rules. `api` and `worker` each write their own queries — no shared repository layer, which would couple their release cycles into a god-package.

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.env.example`, `vitest.workspace.ts`
- Create: `packages/domain/{package.json,tsconfig.json}`, `packages/db/{package.json,tsconfig.json}`
- Create: `apps/api/{package.json,tsconfig.json}`, `apps/worker/{package.json,tsconfig.json}`

**Interfaces:**
- Consumes: nothing.
- Produces: workspace package names `@marketplace/domain`, `@marketplace/db`, `@marketplace/api`, `@marketplace/worker`, `@marketplace/web`. Root scripts `typecheck`, `test`, `test:integration`, `lint`.

- [ ] **Step 1: Create the workspace manifest**

`pnpm-workspace.yaml`:
```yaml
packages:
  - 'packages/*'
  - 'apps/*'
```

Root `package.json`:
```json
{
  "name": "creator-marketplace",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20.11" },
  "scripts": {
    "typecheck": "tsc -b",
    "test": "vitest run --project unit",
    "test:integration": "vitest run --project integration",
    "db:generate": "pnpm --filter @marketplace/db generate",
    "db:migrate": "pnpm --filter @marketplace/db migrate",
    "db:seed": "pnpm --filter @marketplace/db seed",
    "bootstrap": "pnpm db:migrate && pnpm db:seed && pnpm --filter @marketplace/worker start:once"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^2.1.0",
    "tsx": "^4.19.0",
    "@types/node": "^22.10.0"
  }
}
```

- [ ] **Step 2: Create the shared TypeScript config**

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "composite": true,
    "skipLibCheck": true,
    "isolatedModules": true
  }
}
```

`noUncheckedIndexedAccess` matters here: the winner-selection loop indexes into a sorted array, and this flag forces the undefined check instead of letting a bad index silently become `undefined` at runtime.

- [ ] **Step 3: Create the two package manifests**

`packages/domain/package.json`:
```json
{
  "name": "@marketplace/domain",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" }
}
```

`packages/db/package.json`:
```json
{
  "name": "@marketplace/db",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts", "./schema": "./src/schema.ts" },
  "scripts": {
    "generate": "drizzle-kit generate",
    "migrate": "tsx src/migrate.ts",
    "seed": "tsx src/seed.ts"
  },
  "dependencies": {
    "drizzle-orm": "^0.38.0",
    "postgres": "^3.4.5",
    "@marketplace/domain": "workspace:*"
  },
  "devDependencies": { "drizzle-kit": "^0.30.0" }
}
```

Source-level `exports` (pointing at `.ts`, not `dist/`) keeps the inner loop fast — no build step between packages during development. The Docker images compile with `tsc` for production.

- [ ] **Step 4: Create the vitest workspace with two projects**

`vitest.workspace.ts`:
```ts
import { defineWorkspace } from 'vitest/config'

export default defineWorkspace([
  {
    // Pure, fast, no external dependencies. Runs on every save.
    test: {
      name: 'unit',
      include: ['packages/**/*.test.ts', 'apps/api/**/*.test.ts'],
      exclude: ['**/*.integration.test.ts'],
    },
  },
  {
    // Needs a real Postgres. Serial: these tests contend on locks by design.
    test: {
      name: 'integration',
      include: ['apps/**/*.integration.test.ts', 'packages/**/*.integration.test.ts'],
      testTimeout: 30_000,
    },
  },
])
```

Separating the projects is deliberate: the unit suite must stay fast enough to run constantly, and the integration suite must run serially because its whole purpose is to contend on database locks.

Serialisation is expressed as `--no-file-parallelism` on the root `test:integration` script, **not** as `fileParallelism: false` in the project config: Vitest honours that option only at the root of a workspace and silently ignores it inside a project. Setting it in the project looks correct, does nothing, and leaves the suite passing on test-ordering luck — confirmed by observing the schema file's PK-violation assertion turn into a foreign-key error once the worker file began truncating shared tables underneath it.

- [ ] **Step 5: Create `.env.example`**

```bash
# Postgres. Compose overrides host to `postgres`.
DATABASE_URL=postgres://marketplace:marketplace@localhost:5432/marketplace
DATABASE_URL_TEST=postgres://marketplace:marketplace@localhost:5432/marketplace_test

# API
PORT=3000
LOG_LEVEL=info
# Enables POST /api/dev/campaigns/:id/expire. Compose sets this true.
ENABLE_DEV_TOOLS=false

# Worker
CLOSE_INTERVAL_MS=15000
MAX_CAMPAIGNS_PER_RUN=50
```

- [ ] **Step 6: Install and verify**

Run: `pnpm install && pnpm typecheck`
Expected: install succeeds; `tsc -b` exits 0 with no files to compile yet.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: pnpm workspace scaffold with strict TS and split unit/integration test projects"
```

---

### Task 2: Database schema, migration and client

**Files:**
- Create: `packages/db/src/schema.ts`, `packages/db/src/client.ts`, `packages/db/src/migrate.ts`, `packages/db/src/index.ts`, `packages/db/drizzle.config.ts`
- Create: `packages/db/drizzle/0000_init.sql` (generated, then hand-extended)
- Create: `packages/db/src/schema.integration.test.ts`

**Interfaces:**
- Consumes: the `Genre` *type* from `@marketplace/domain` (Task 3 defines it; execute Task 3 before Task 2). The value list is restated locally — see the comment in the schema for why, and for the assertion that keeps the two in step.
- Produces: `createDb(url: string): Database`, and table objects `creators`, `campaigns`, `closingRuns`, `bids`, `campaignClosings`, `bidEvents`. Inferred row types `Creator`, `Campaign`, `Bid`, `NewBid`, etc. Enum objects `genreEnum`, `campaignStatusEnum`, `bidStatusEnum`, `bidEventTypeEnum`.

- [ ] **Step 1: Write the schema**

`packages/db/src/schema.ts`:
```ts
import {
  pgTable, pgEnum, uuid, text, varchar, integer, bigint, numeric,
  timestamp, jsonb, bigserial, index, uniqueIndex, check,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import type { Genre } from '@marketplace/domain'

/**
 * The genre list is restated here rather than imported as a value, because
 * drizzle-kit bundles this file as CJS and cannot resolve the domain package's
 * ESM `.js` specifiers. A type-only import survives that bundling (it is
 * erased), a value import does not.
 *
 * The duplication cannot drift: GENRE_VALUES must be *exactly* the Genre union,
 * and the assertion below is a compile error if a genre is added to or removed
 * from either side. `satisfies` alone would only prove every value is a Genre,
 * not that every Genre is present — hence the bidirectional check.
 */
const GENRE_VALUES = [
  'beauty', 'fashion', 'fitness', 'gaming', 'music', 'food', 'tech', 'travel',
] as const satisfies readonly Genre[]

type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never
const _genreListIsExhaustive: MutuallyAssignable<Genre, (typeof GENRE_VALUES)[number]> = true
void _genreListIsExhaustive

export const genreEnum         = pgEnum('genre', GENRE_VALUES)
export const campaignStatusEnum = pgEnum('campaign_status', ['open', 'closed'])
export const bidStatusEnum      = pgEnum('bid_status', ['pending', 'won', 'lost', 'withdrawn'])
export const bidEventTypeEnum   = pgEnum('bid_event_type',
  ['placed', 'repriced', 'withdrawn', 'reinstated', 'won', 'lost'])

export const creators = pgTable('creators', {
  id:             uuid('id').primaryKey().defaultRandom(),
  handle:         varchar('handle', { length: 64 }).notNull().unique(),
  displayName:    text('display_name').notNull(),
  genre:          genreEnum('genre').notNull(),
  followerCount:  integer('follower_count').notNull(),
  // numeric comes back as a string from the driver; parsed at the repository edge.
  engagementRate: numeric('engagement_rate', { precision: 5, scale: 4 }).notNull(),
  // Stats are a projection of an external scraper pipeline, not facts we own.
  statsUpdatedAt: timestamp('stats_updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('creators_followers_non_negative', sql`${t.followerCount} >= 0`),
  check('creators_engagement_in_range', sql`${t.engagementRate} BETWEEN 0 AND 1`),
])

export const campaigns = pgTable('campaigns', {
  id:                uuid('id').primaryKey().defaultRandom(),
  brandName:         text('brand_name').notNull(),
  title:             text('title').notNull(),
  brief:             text('brief').notNull(),
  targetGenre:       genreEnum('target_genre').notNull(),
  minFollowers:      integer('min_followers').notNull().default(0),
  minEngagementRate: numeric('min_engagement_rate', { precision: 5, scale: 4 }).notNull().default('0'),
  budgetCents:       bigint('budget_cents', { mode: 'number' }).notNull(),
  biddingDeadline:   timestamp('bidding_deadline', { withTimezone: true }).notNull(),
  status:            campaignStatusEnum('status').notNull().default('open'),
  createdAt:         timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('campaigns_budget_positive', sql`${t.budgetCents} > 0`),
  check('campaigns_min_followers_non_negative', sql`${t.minFollowers} >= 0`),
  check('campaigns_min_engagement_in_range', sql`${t.minEngagementRate} BETWEEN 0 AND 1`),
  // The closer's hot path. Partial, so it only indexes campaigns awaiting closure
  // and stays small as the table grows without bound.
  index('campaigns_open_by_deadline_idx')
    .on(t.biddingDeadline)
    .where(sql`${t.status} = 'open'`),
])

// One row per pass of the closing worker: the durable join key between a decided
// bid and the run that decided it.
export const closingRuns = pgTable('closing_runs', {
  id:                uuid('id').primaryKey().defaultRandom(),
  startedAt:         timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt:        timestamp('finished_at', { withTimezone: true }),
  campaignsClosed:   integer('campaigns_closed').notNull().default(0),
  bidsDecided:       integer('bids_decided').notNull().default(0),
  totalAwardedCents: bigint('total_awarded_cents', { mode: 'number' }).notNull().default(0),
  error:             text('error'),
}, (t) => [
  // finished_at IS NULL with an old started_at is a crashed worker. Partial index
  // makes that a cheap query, so it can back a real alert.
  index('closing_runs_unfinished_idx').on(t.startedAt).where(sql`${t.finishedAt} IS NULL`),
])

export const bids = pgTable('bids', {
  id:          uuid('id').primaryKey().defaultRandom(),
  campaignId:  uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  creatorId:   uuid('creator_id').notNull().references(() => creators.id, { onDelete: 'cascade' }),
  amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
  fitScore:    numeric('fit_score', { precision: 5, scale: 2 }).notNull(),
  pitch:       text('pitch'),
  status:      bidStatusEnum('status').notNull().default('pending'),
  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:   timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  decidedAt:   timestamp('decided_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('bids_one_per_creator_per_campaign').on(t.campaignId, t.creatorId),
  index('bids_by_creator_idx').on(t.creatorId, t.createdAt.desc()),
  check('bids_amount_positive', sql`${t.amountCents} > 0`),
  check('bids_fit_score_in_range', sql`${t.fitScore} BETWEEN 0 AND 100`),
  // Makes "a won bid with no decision timestamp" unrepresentable.
  check('bids_decided_at_matches_status',
    sql`(${t.status} IN ('won','lost')) = (${t.decidedAt} IS NOT NULL)`),
])

export const campaignClosings = pgTable('campaign_closings', {
  // PRIMARY KEY, not just FK: a second attempt to close the same campaign dies on
  // a unique violation even if every line of the locking logic is wrong.
  campaignId:        uuid('campaign_id').primaryKey()
                       .references(() => campaigns.id, { onDelete: 'restrict' }),
  runId:             uuid('run_id').notNull().references(() => closingRuns.id),
  closedAt:          timestamp('closed_at', { withTimezone: true }).notNull().defaultNow(),
  bidCount:          integer('bid_count').notNull(),
  winningBidCount:   integer('winning_bid_count').notNull(),
  totalAwardedCents: bigint('total_awarded_cents', { mode: 'number' }).notNull(),
}, (t) => [
  check('closings_counts_non_negative',
    sql`${t.bidCount} >= 0 AND ${t.winningBidCount} >= 0 AND ${t.totalAwardedCents} >= 0`),
  check('closings_winners_within_bids', sql`${t.winningBidCount} <= ${t.bidCount}`),
])

export const bidEvents = pgTable('bid_events', {
  // BIGSERIAL: monotonic ordering, append-only index inserts, natural cursor.
  id:          bigserial('id', { mode: 'number' }).primaryKey(),
  bidId:       uuid('bid_id').notNull().references(() => bids.id, { onDelete: 'cascade' }),
  type:        bidEventTypeEnum('type').notNull(),
  amountCents: bigint('amount_cents', { mode: 'number' }),
  fitScore:    numeric('fit_score', { precision: 5, scale: 2 }),
  // Provenance, not identity: with no auth we record which component acted.
  actor:       text('actor').notNull(),
  runId:       uuid('run_id').references(() => closingRuns.id),
  metadata:    jsonb('metadata').notNull().default({}),
  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('bid_events_by_bid_idx').on(t.bidId, t.id),
])

export type Creator  = typeof creators.$inferSelect
export type Campaign = typeof campaigns.$inferSelect
export type Bid      = typeof bids.$inferSelect
export type NewBid   = typeof bids.$inferInsert
export type ClosingRun = typeof closingRuns.$inferSelect
```

- [ ] **Step 2: Create the client and migrate entrypoints**

`packages/db/src/client.ts`:
```ts
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema.js'

export type Database = ReturnType<typeof createDb>['db']

export function createDb(url: string, opts: { max?: number } = {}) {
  const sql = postgres(url, { max: opts.max ?? 10, onnotice: () => {} })
  const db = drizzle(sql, { schema })
  return { db, sql, close: () => sql.end({ timeout: 5 }) }
}
```

`packages/db/src/migrate.ts`:
```ts
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { createDb } from './client.js'

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is required')

// max: 1 — migrations must run on a single connection, in order.
const { db, close } = createDb(url, { max: 1 })
await migrate(db, { migrationsFolder: new URL('../drizzle', import.meta.url).pathname })
await close()
console.log('migrations applied')
```

`packages/db/drizzle.config.ts`:
```ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
  casing: 'snake_case',
})
```

`packages/db/src/index.ts`:
```ts
export * from './schema.js'
export { createDb, type Database } from './client.js'
```

- [ ] **Step 3: Generate the migration**

Run:
```bash
docker run -d --name cm-pg -e POSTGRES_USER=marketplace -e POSTGRES_PASSWORD=marketplace \
  -e POSTGRES_DB=marketplace -p 5432:5432 postgres:16-alpine
export DATABASE_URL=postgres://marketplace:marketplace@localhost:5432/marketplace
pnpm db:generate
```
Expected: `packages/db/drizzle/0000_*.sql` created.

Then **read the generated SQL** and confirm it contains the four enum types, the two partial indexes (`WHERE status = 'open'`, `WHERE finished_at IS NULL`), and every `CHECK` constraint. Drizzle's `check()` and partial-index support vary by version; if any are missing, append them by hand to the generated file — the generated migration is a starting point, not gospel, and the SQL in spec §4 is the target state.

*Verified on drizzle-orm 0.38.4 / drizzle-kit 0.30.6: all four enums, all ten `CHECK` constraints and both partial-index predicates are emitted, and Postgres 16 accepts the table-qualified predicate form drizzle generates. Nothing had to be hand-appended.*

- [ ] **Step 4: Write the schema integration test**

`packages/db/src/schema.integration.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createDb } from './client.js'
import { creators, campaigns, bids, closingRuns, campaignClosings } from './schema.js'
import { randomUUID } from 'node:crypto'

const url = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL!
let ctx: ReturnType<typeof createDb>

beforeAll(() => { ctx = createDb(url, { max: 2 }) })
afterAll(async () => { await ctx.close() })

// These tests assert the database refuses bad data. They are the proof that the
// invariants survive a bug in application code.
describe('schema constraints', () => {
  it('rejects a negative follower count', async () => {
    await expect(ctx.db.insert(creators).values({
      handle: `h-${randomUUID()}`, displayName: 'x', genre: 'music',
      followerCount: -1, engagementRate: '0.05',
    })).rejects.toThrow(/creators_followers_non_negative/)
  })

  it('rejects an engagement rate above 1', async () => {
    await expect(ctx.db.insert(creators).values({
      handle: `h-${randomUUID()}`, displayName: 'x', genre: 'music',
      followerCount: 100, engagementRate: '1.5',
    })).rejects.toThrow(/creators_engagement_in_range/)
  })

  it('rejects a non-positive budget', async () => {
    await expect(ctx.db.insert(campaigns).values({
      brandName: 'b', title: 't', brief: 'b', targetGenre: 'music',
      budgetCents: 0, biddingDeadline: new Date(),
    })).rejects.toThrow(/campaigns_budget_positive/)
  })

  it('rejects a won bid with no decided_at', async () => {
    const [creator] = await ctx.db.insert(creators).values({
      handle: `h-${randomUUID()}`, displayName: 'x', genre: 'music',
      followerCount: 100, engagementRate: '0.05',
    }).returning()
    const [campaign] = await ctx.db.insert(campaigns).values({
      brandName: 'b', title: 't', brief: 'b', targetGenre: 'music',
      budgetCents: 100_000, biddingDeadline: new Date(),
    }).returning()

    await expect(ctx.db.insert(bids).values({
      campaignId: campaign!.id, creatorId: creator!.id,
      amountCents: 1000, fitScore: '80.00', status: 'won', decidedAt: null,
    })).rejects.toThrow(/bids_decided_at_matches_status/)
  })

  it('refuses a second closing row for the same campaign', async () => {
    const [run] = await ctx.db.insert(closingRuns).values({}).returning()
    const [campaign] = await ctx.db.insert(campaigns).values({
      brandName: 'b', title: 't', brief: 'b', targetGenre: 'music',
      budgetCents: 100_000, biddingDeadline: new Date(),
    }).returning()

    const row = {
      campaignId: campaign!.id, runId: run!.id,
      bidCount: 0, winningBidCount: 0, totalAwardedCents: 0,
    }
    await ctx.db.insert(campaignClosings).values(row)
    // The structural backstop from spec §7.2 L4.
    await expect(ctx.db.insert(campaignClosings).values(row))
      .rejects.toThrow(/campaign_closings_pkey/)
  })
})
```

- [ ] **Step 5: Run the test**

Run:
```bash
createdb -h localhost -U marketplace marketplace_test 2>/dev/null || true
DATABASE_URL=postgres://marketplace:marketplace@localhost:5432/marketplace_test pnpm db:migrate
pnpm test:integration -- packages/db
```
Expected: 5 passing. If any assertion fails because a constraint is absent from the migration, add the missing SQL to the migration file and re-run — do not weaken the test.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(db): schema with enums, partial indexes, and CHECK constraints proved by integration tests"
```

---

### Task 3: Domain primitives — money and genre affinity

**Files:**
- Create: `packages/domain/src/money.ts`, `packages/domain/src/genre.ts`, `packages/domain/src/index.ts`
- Test: `packages/domain/src/money.test.ts`, `packages/domain/src/genre.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `GENRES: readonly Genre[]`, `type Genre`, `isGenre(v: string): v is Genre`
  - `genreAffinity(creatorGenre: Genre, targetGenre: Genre): number` → one of `1.0 | 0.6 | 0.2`
  - `GENRE_AFFINITY: { exact: 1.0, adjacent: 0.6, unrelated: 0.2 }`
  - `type Cents = number` (branded), `toCents(euros: number): Cents`, `centsToEuros(c: Cents): number`, `formatEur(c: Cents): string`, `parseEuroInput(s: string): Cents | null`

- [ ] **Step 1: Write the failing money test**

`packages/domain/src/money.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { toCents, centsToEuros, formatEur, parseEuroInput } from './money.js'

describe('money', () => {
  it('converts euros to integer cents', () => {
    expect(toCents(12.34)).toBe(1234)
    expect(toCents(0.1)).toBe(10)
  })

  // The reason this module exists: 0.1 + 0.2 !== 0.3 in IEEE 754, and a naive
  // euros * 100 lands on the wrong side of a cent boundary — 1.005 * 100 is
  // 100.49999999999999, so rounding the product rounds a number that is
  // already wrong.
  it('rounds float artefacts instead of truncating them', () => {
    expect(toCents(10.05)).toBe(1005)
    expect(toCents(1.005)).toBe(101) // half-up at the cent boundary
  })

  it('rejects non-finite and negative amounts', () => {
    expect(() => toCents(NaN)).toThrow()
    expect(() => toCents(Infinity)).toThrow()
    expect(() => toCents(-1)).toThrow()
  })

  // A cent count above 2^53 stops being an exact integer in JS, so it must be
  // refused at the boundary rather than silently losing precision later.
  it('rejects amounts whose cent value would exceed exact integer range', () => {
    expect(() => toCents(Number.MAX_SAFE_INTEGER)).toThrow()
  })

  it('formats cents as EUR without reintroducing floats in the output', () => {
    // Fed through toCents rather than raw literals: Cents is branded, so a
    // bare number does not typecheck here — which is the point of the brand.
    expect(formatEur(toCents(12.34))).toBe('€12.34')
    expect(formatEur(toCents(1000))).toBe('€1,000.00')
    expect(formatEur(toCents(0))).toBe('€0.00')
  })

  it('round-trips', () => {
    for (const euros of [0.01, 1, 12.34, 999.99, 1_000_000]) {
      expect(centsToEuros(toCents(euros))).toBeCloseTo(euros, 2)
    }
  })

  it('parses user input, returning null rather than throwing on garbage', () => {
    expect(parseEuroInput('1200')).toBe(120_000)
    expect(parseEuroInput('1200.50')).toBe(120_050)
    expect(parseEuroInput('1.200,50')).toBe(120_050) // de-DE grouping
    expect(parseEuroInput('')).toBeNull()
    expect(parseEuroInput('abc')).toBeNull()
    expect(parseEuroInput('-5')).toBeNull()
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm test -- money`
Expected: FAIL — `Cannot find module './money.js'`

- [ ] **Step 3: Implement money.ts**

```ts
declare const centsBrand: unique symbol

/**
 * An integer number of euro cents. Branded so a raw number cannot be passed
 * where cents are expected — the compiler enforces that the euro→cent
 * conversion actually happened.
 */
export type Cents = number & { readonly [centsBrand]: true }

/**
 * Above this, the cent count exceeds 2^53 - 1 and stops being an exact integer
 * in JS. The column is BIGINT, so the database could hold more than the
 * application can represent; the boundary refuses the gap instead of hiding it.
 *
 * It also keeps `euros` below 1e21, the point at which JS switches to
 * exponential notation in string conversion — which the scaling below relies on.
 */
const MAX_EUROS = Number.MAX_SAFE_INTEGER / 100

export function toCents(euros: number): Cents {
  if (!Number.isFinite(euros)) throw new Error(`not a finite amount: ${euros}`)
  if (euros < 0) throw new Error(`amount must not be negative: ${euros}`)
  if (euros > MAX_EUROS) throw new Error(`amount exceeds exact integer range: ${euros}`)

  // Scale by shifting the decimal exponent in the *string*, before the double
  // is constructed — not by multiplying. Multiplying introduces its own error:
  // 1.005 * 100 is 100.49999999999999, so Math.round of the product yields 100
  // and quietly loses a cent. Number('1.005e2') is exactly 100.5, which rounds
  // half-up to 101 as a reader of this function would expect.
  return Math.round(Number(`${euros}e2`)) as Cents
}

export const centsToEuros = (c: Cents): number => c / 100

const EUR = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' })
export const formatEur = (c: Cents): string => EUR.format(centsToEuros(c))

/**
 * Parses a user-typed amount. Returns null for anything unparseable rather
 * than throwing, because this runs on every keystroke in the bid form.
 * Accepts both "1200.50" and de-DE "1.200,50".
 */
export function parseEuroInput(input: string): Cents | null {
  const trimmed = input.trim().replace(/[€\s]/g, '')
  if (trimmed === '') return null

  // If a comma appears after the last dot, treat comma as the decimal separator.
  const normalised = trimmed.lastIndexOf(',') > trimmed.lastIndexOf('.')
    ? trimmed.replace(/\./g, '').replace(',', '.')
    : trimmed.replace(/,/g, '')

  if (!/^\d+(\.\d{1,2})?$/.test(normalised)) return null
  return toCents(Number(normalised))
}
```

- [ ] **Step 4: Run and confirm pass**

Run: `pnpm test -- money`
Expected: PASS (7 tests)

- [ ] **Step 5: Write the failing genre test**

`packages/domain/src/genre.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { GENRES, genreAffinity, GENRE_AFFINITY, isGenre } from './genre.js'

describe('genre affinity', () => {
  it('scores an exact match highest', () => {
    expect(genreAffinity('fitness', 'fitness')).toBe(GENRE_AFFINITY.exact)
  })

  it('scores a declared adjacency in between', () => {
    expect(genreAffinity('fitness', 'food')).toBe(GENRE_AFFINITY.adjacent)
    expect(genreAffinity('beauty', 'fashion')).toBe(GENRE_AFFINITY.adjacent)
  })

  it('scores an unrelated pair lowest but never zero', () => {
    expect(genreAffinity('gaming', 'beauty')).toBe(GENRE_AFFINITY.unrelated)
    // Non-zero on purpose: cross-genre deals happen, so an unrelated creator
    // should rank last rather than be effectively excluded.
    expect(GENRE_AFFINITY.unrelated).toBeGreaterThan(0)
  })

  // Adjacency is a symmetric relation. Hand-written maps drift, so assert it
  // across every pair instead of trusting the table to stay consistent.
  it('is symmetric for every pair of genres', () => {
    for (const a of GENRES) {
      for (const b of GENRES) {
        expect(genreAffinity(a, b)).toBe(genreAffinity(b, a))
      }
    }
  })

  it('never returns a value outside the declared band', () => {
    for (const a of GENRES) for (const b of GENRES) {
      expect([GENRE_AFFINITY.exact, GENRE_AFFINITY.adjacent, GENRE_AFFINITY.unrelated])
        .toContain(genreAffinity(a, b))
    }
  })

  it('narrows unknown strings', () => {
    expect(isGenre('music')).toBe(true)
    expect(isGenre('polka')).toBe(false)
  })
})
```

- [ ] **Step 6: Run it and confirm it fails**

Run: `pnpm test -- genre`
Expected: FAIL — module not found

- [ ] **Step 7: Implement genre.ts**

```ts
export const GENRES = [
  'beauty', 'fashion', 'fitness', 'gaming', 'music', 'food', 'tech', 'travel',
] as const

export type Genre = (typeof GENRES)[number]

export const isGenre = (v: string): v is Genre => (GENRES as readonly string[]).includes(v)

export const GENRE_AFFINITY = {
  exact: 1.0,
  adjacent: 0.6,
  unrelated: 0.2,
} as const

/**
 * Declared adjacencies, as unordered pairs. A brand buying "food" content is
 * plausibly served by a fitness creator (protein, supplements) but not by a
 * gaming creator, so near-misses should outrank unrelated ones instead of all
 * non-matches collapsing to the same score.
 *
 * Stored as pairs rather than a Record<Genre, Genre[]> so symmetry cannot drift:
 * there is exactly one place each relationship is written down.
 */
const ADJACENT_PAIRS: ReadonlyArray<readonly [Genre, Genre]> = [
  ['fitness', 'food'],
  ['beauty', 'fashion'],
  ['gaming', 'tech'],
  ['music', 'gaming'],
  ['travel', 'food'],
  ['fashion', 'travel'],
  ['tech', 'music'],
]

const ADJACENCY: ReadonlySet<string> = new Set(
  ADJACENT_PAIRS.flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`]),
)

export function genreAffinity(creatorGenre: Genre, targetGenre: Genre): number {
  if (creatorGenre === targetGenre) return GENRE_AFFINITY.exact
  if (ADJACENCY.has(`${creatorGenre}|${targetGenre}`)) return GENRE_AFFINITY.adjacent
  return GENRE_AFFINITY.unrelated
}
```

Storing adjacency as a flat list of pairs and deriving the lookup set is what makes the symmetry test pass by construction rather than by vigilance — there is one place each relationship is written.

- [ ] **Step 8: Run and confirm pass, then export from index**

Run: `pnpm test -- genre`
Expected: PASS (6 tests)

`packages/domain/src/index.ts`:
```ts
export * from './money.js'
export * from './genre.js'
```

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(domain): branded cent arithmetic and symmetric genre affinity"
```

---

### Task 4: Eligibility and fit score — **YOU WRITE `scoreFit`**

**Files:**
- Create: `packages/domain/src/matching.ts`
- Test: `packages/domain/src/matching.test.ts`
- Modify: `packages/domain/src/index.ts`

**Interfaces:**
- Consumes: `Genre`, `genreAffinity` from `./genre.js`
- Produces:
  - `type CreatorProfile = { genre: Genre; followerCount: number; engagementRate: number }`
  - `type CampaignRequirements = { targetGenre: Genre; minFollowers: number; minEngagementRate: number }`
  - `type IneligibilityReason` (discriminated union, see Step 3)
  - `checkEligibility(c: CreatorProfile, r: CampaignRequirements): IneligibilityReason[]`
  - `scoreFit(c: CreatorProfile, r: CampaignRequirements): FitScore`
  - `type FitScore = { total: number; components: ScoreComponent[] }`
  - Constants `FIT_WEIGHTS`, `ENGAGEMENT_CEILING`, `AUDIENCE_BASELINE`, `AUDIENCE_SATURATION_MULTIPLE`

- [ ] **Step 1: Write the types and `checkEligibility`**

`packages/domain/src/matching.ts`:
```ts
import { genreAffinity, type Genre } from './genre.js'

export type CreatorProfile = {
  genre: Genre
  followerCount: number
  /** 0..1, e.g. 0.042 for 4.2% */
  engagementRate: number
}

export type CampaignRequirements = {
  targetGenre: Genre
  minFollowers: number
  minEngagementRate: number
}

/**
 * A discriminated union rather than a string, so the UI can render the actual
 * numbers ("needs 50k followers, you have 32k") instead of a generic message.
 * Telling a creator what to grow toward is the difference between a filter and
 * a product.
 */
export type IneligibilityReason =
  | { code: 'BELOW_MIN_FOLLOWERS'; required: number; actual: number }
  | { code: 'BELOW_MIN_ENGAGEMENT'; required: number; actual: number }

/** Hard gates. Contractual floors the brand set — not soft preferences. */
export function checkEligibility(
  creator: CreatorProfile,
  requirements: CampaignRequirements,
): IneligibilityReason[] {
  const reasons: IneligibilityReason[] = []
  if (creator.followerCount < requirements.minFollowers) {
    reasons.push({
      code: 'BELOW_MIN_FOLLOWERS',
      required: requirements.minFollowers,
      actual: creator.followerCount,
    })
  }
  if (creator.engagementRate < requirements.minEngagementRate) {
    reasons.push({
      code: 'BELOW_MIN_ENGAGEMENT',
      required: requirements.minEngagementRate,
      actual: creator.engagementRate,
    })
  }
  return reasons
}

export const isEligible = (c: CreatorProfile, r: CampaignRequirements): boolean =>
  checkEligibility(c, r).length === 0

// ─── Fit score ────────────────────────────────────────────────────────────────

export const FIT_WEIGHTS = { genre: 0.5, engagement: 0.3, audience: 0.2 } as const

/** Engagement at or above this is exceptional; the component saturates here. */
export const ENGAGEMENT_CEILING = 0.08

/**
 * Reference audience for a campaign that states no follower minimum. Without
 * this, `followers / 0` is a division by zero, and conceptually every creator
 * would score a perfect 1.0 — so the component would stop discriminating on
 * exactly the campaigns where nothing else constrains it.
 */
export const AUDIENCE_BASELINE = 10_000

/** Audience fit reaches 1.0 at this multiple of the reference and stops. */
export const AUDIENCE_SATURATION_MULTIPLE = 10

export type ScoreComponent = {
  key: 'genre' | 'engagement' | 'audience'
  label: string
  /** 0..1 */
  score: number
  weight: number
  /** Human-readable justification rendered in the UI. */
  detail: string
}

export type FitScore = {
  /** 0..100, rounded to two decimals to match the NUMERIC(5,2) column. */
  total: number
  components: ScoreComponent[]
}
```

- [ ] **Step 2: Write the failing test suite for `scoreFit`**

Append to `packages/domain/src/matching.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import {
  checkEligibility, isEligible, scoreFit,
  FIT_WEIGHTS, ENGAGEMENT_CEILING, AUDIENCE_BASELINE, AUDIENCE_SATURATION_MULTIPLE,
  type CreatorProfile, type CampaignRequirements,
} from './matching.js'

const creator = (o: Partial<CreatorProfile> = {}): CreatorProfile => ({
  genre: 'fitness', followerCount: 100_000, engagementRate: 0.04, ...o,
})
const campaign = (o: Partial<CampaignRequirements> = {}): CampaignRequirements => ({
  targetGenre: 'fitness', minFollowers: 10_000, minEngagementRate: 0.02, ...o,
})

describe('checkEligibility', () => {
  it('passes a creator who clears both gates', () => {
    expect(checkEligibility(creator(), campaign())).toEqual([])
  })

  // Boundary: the requirement is a floor, so exactly meeting it must pass.
  it('treats the minimum as inclusive', () => {
    expect(isEligible(creator({ followerCount: 10_000 }), campaign({ minFollowers: 10_000 }))).toBe(true)
    expect(isEligible(creator({ followerCount: 9_999 }), campaign({ minFollowers: 10_000 }))).toBe(false)
  })

  it('reports every failed gate, with the numbers needed to explain it', () => {
    const reasons = checkEligibility(
      creator({ followerCount: 5_000, engagementRate: 0.01 }),
      campaign({ minFollowers: 50_000, minEngagementRate: 0.03 }),
    )
    expect(reasons).toEqual([
      { code: 'BELOW_MIN_FOLLOWERS', required: 50_000, actual: 5_000 },
      { code: 'BELOW_MIN_ENGAGEMENT', required: 0.03, actual: 0.01 },
    ])
  })

  // Genre is a soft signal, not a gate — see spec §5.2.
  it('does not gate on genre', () => {
    expect(isEligible(creator({ genre: 'gaming' }), campaign({ targetGenre: 'beauty' }))).toBe(true)
  })
})

describe('scoreFit', () => {
  it('declares weights that sum to exactly 1', () => {
    const sum = FIT_WEIGHTS.genre + FIT_WEIGHTS.engagement + FIT_WEIGHTS.audience
    expect(sum).toBeCloseTo(1, 10)
  })

  it('returns 100 for a perfect creator', () => {
    const score = scoreFit(
      creator({ genre: 'fitness', engagementRate: ENGAGEMENT_CEILING, followerCount: 1_000_000 }),
      campaign({ targetGenre: 'fitness', minFollowers: 10_000 }),
    )
    expect(score.total).toBeCloseTo(100, 2)
  })

  it('stays within 0..100 across a wide input sweep', () => {
    for (const followerCount of [0, 1, 1_000, 10_000, 1_000_000, 50_000_000]) {
      for (const engagementRate of [0, 0.001, 0.04, 0.08, 0.5, 1]) {
        for (const genre of ['fitness', 'food', 'gaming'] as const) {
          const { total } = scoreFit(creator({ followerCount, engagementRate, genre }), campaign())
          expect(total).toBeGreaterThanOrEqual(0)
          expect(total).toBeLessThanOrEqual(100)
          expect(Number.isFinite(total)).toBe(true)
        }
      }
    }
  })

  it('returns one component per weighted dimension, each in 0..1', () => {
    const { components } = scoreFit(creator(), campaign())
    expect(components.map((c) => c.key).sort()).toEqual(['audience', 'engagement', 'genre'])
    for (const c of components) {
      expect(c.score).toBeGreaterThanOrEqual(0)
      expect(c.score).toBeLessThanOrEqual(1)
      expect(c.weight).toBe(FIT_WEIGHTS[c.key])
      expect(c.detail.length).toBeGreaterThan(0)
    }
  })

  it('has a total that equals the weighted sum of its own components', () => {
    const score = scoreFit(creator({ genre: 'food' }), campaign())
    const recomputed = score.components.reduce((acc, c) => acc + c.score * c.weight, 0) * 100
    // The breakdown shown in the UI must actually add up to the headline number,
    // or the explanation is a lie.
    expect(score.total).toBeCloseTo(recomputed, 1)
  })

  it('ranks exact genre above adjacent above unrelated, all else equal', () => {
    const exact     = scoreFit(creator({ genre: 'fitness' }), campaign({ targetGenre: 'fitness' })).total
    const adjacent  = scoreFit(creator({ genre: 'food' }),    campaign({ targetGenre: 'fitness' })).total
    const unrelated = scoreFit(creator({ genre: 'beauty' }),  campaign({ targetGenre: 'fitness' })).total
    expect(exact).toBeGreaterThan(adjacent)
    expect(adjacent).toBeGreaterThan(unrelated)
  })

  // The economic point from spec §5.3: a campaign needing 10k followers gets no
  // extra value from a 5M creator, who will be expensive.
  it('saturates audience fit at the saturation multiple', () => {
    const at10x  = scoreFit(creator({ followerCount: 100_000 }),    campaign({ minFollowers: 10_000 })).total
    const at100x = scoreFit(creator({ followerCount: 1_000_000 }),  campaign({ minFollowers: 10_000 })).total
    const at500x = scoreFit(creator({ followerCount: 5_000_000 }),  campaign({ minFollowers: 10_000 })).total
    expect(at10x).toBeCloseTo(at100x, 2)
    expect(at100x).toBeCloseTo(at500x, 2)
  })

  // Without this the engagement component has no discriminating test at all:
  // every other engagement assertion is a saturation or a bounds check, which a
  // function returning a constant would satisfy.
  it('rewards higher engagement below the ceiling', () => {
    const low  = scoreFit(creator({ engagementRate: 0.02 }), campaign()).total
    const mid  = scoreFit(creator({ engagementRate: 0.05 }), campaign()).total
    const high = scoreFit(creator({ engagementRate: ENGAGEMENT_CEILING }), campaign()).total
    expect(mid).toBeGreaterThan(low)
    expect(high).toBeGreaterThan(mid)
  })

  it('saturates engagement fit at the ceiling', () => {
    const atCeiling = scoreFit(creator({ engagementRate: ENGAGEMENT_CEILING }), campaign()).total
    const wayAbove  = scoreFit(creator({ engagementRate: 0.5 }), campaign()).total
    expect(atCeiling).toBeCloseTo(wayAbove, 2)
  })

  it('falls back to the baseline audience when a campaign states no minimum', () => {
    const noMinimum = campaign({ minFollowers: 0 })
    const small = scoreFit(creator({ followerCount: 1_000 }), noMinimum).total
    const large = scoreFit(creator({ followerCount: AUDIENCE_BASELINE * AUDIENCE_SATURATION_MULTIPLE }), noMinimum).total
    // Must still discriminate: a 0 minimum is not "everyone scores full marks".
    expect(large).toBeGreaterThan(small)
    expect(Number.isFinite(small)).toBe(true)
  })

  it('never produces NaN for a zero-follower or zero-engagement creator', () => {
    const { total } = scoreFit(
      creator({ followerCount: 0, engagementRate: 0 }),
      campaign({ minFollowers: 0, minEngagementRate: 0 }),
    )
    expect(Number.isNaN(total)).toBe(false)
    expect(total).toBeGreaterThanOrEqual(0)
  })

  it('is a pure function of its inputs', () => {
    const c = creator(), r = campaign()
    expect(scoreFit(c, r)).toEqual(scoreFit(c, r))
  })
})
```

- [ ] **Step 3: Run it and confirm the `scoreFit` tests fail**

Run: `pnpm test -- matching`
Expected: the four `checkEligibility` tests PASS; five `scoreFit` tests FAIL — `returns 100 for a perfect creator`, `returns one component per weighted dimension`, `ranks exact genre above adjacent`, `rewards higher engagement below the ceiling`, and `falls back to the baseline audience`.

Note that the other `scoreFit` tests pass against the stub, because a function returning a constant `0` trivially satisfies a bounds check, a saturation check, and a purity check. Those tests are regression guards, not specifications — the five above are what actually pin the behaviour.

- [ ] **Step 4: 🧑 YOUR TURN — implement `scoreFit`**

Append this to `packages/domain/src/matching.ts` and fill in the three component
calculations. The signature, the return shape, and the constants are fixed by the tests
above; the curves are yours.

```ts
/**
 * Scores how well a creator fits a campaign, 0..100, with a per-component
 * breakdown the UI renders so a creator can see *why*.
 *
 * Called from two places, and this is the whole reason the domain package exists:
 *   - the API, when ranking campaigns and when snapshotting fit onto a new bid
 *   - the tests
 * The closer never calls it — it reads the snapshot — so the score a creator was
 * shown is provably the score that decided their bid.
 */
export function scoreFit(
  creator: CreatorProfile,
  requirements: CampaignRequirements,
): FitScore {
  // TODO(you): genre component — a straight lookup, weight 0.5
  const genreScore = 0

  // TODO(you): engagement component — saturate at ENGAGEMENT_CEILING, weight 0.3
  const engagementScore = 0

  // TODO(you): audience component — log-scaled, saturating at
  // AUDIENCE_SATURATION_MULTIPLE × reference, where reference is
  // requirements.minFollowers or AUDIENCE_BASELINE when that is 0.
  // Watch: followerCount can be 0, and log10(0) is -Infinity.
  const audienceScore = 0

  const components: ScoreComponent[] = [
    { key: 'genre', label: 'Genre match', score: genreScore, weight: FIT_WEIGHTS.genre,
      detail: '' }, // TODO(you): e.g. `Exact: fitness` / `Adjacent to food`
    { key: 'engagement', label: 'Engagement', score: engagementScore, weight: FIT_WEIGHTS.engagement,
      detail: '' }, // TODO(you): e.g. `4.0% vs 8% target`
    { key: 'audience', label: 'Audience size', score: audienceScore, weight: FIT_WEIGHTS.audience,
      detail: '' }, // TODO(you): e.g. `100k · 10× the 10k minimum`
  ]

  const weighted = components.reduce((acc, c) => acc + c.score * c.weight, 0)
  return { total: round2(weighted * 100), components }
}

/** Two decimals, matching the NUMERIC(5,2) column the snapshot is stored in. */
const round2 = (n: number): number => Math.round(n * 100) / 100
```

**What the decisions are, and what to watch:**

- **`genreScore`** is the easy one: `genreAffinity(creator.genre, requirements.targetGenre)`.
- **`engagementScore`** — `min(1, rate / ENGAGEMENT_CEILING)`. The clamp is what makes it saturate. Decide whether a creator at 0 engagement should score 0 (they will, with this formula) or get a small floor. I'd let it be 0: engagement is the signal most predictive of whether a campaign performs.
- **`audienceScore`** is where the real judgement is, and there are three traps:
  1. `requirements.minFollowers` can be `0` → use `AUDIENCE_BASELINE` as the reference instead.
  2. `creator.followerCount` can be `0` → `log10(0)` is `-Infinity`. Clamp the ratio at a floor before taking the log, or clamp the result to `[0, 1]`.
  3. The saturation point should come from `AUDIENCE_SATURATION_MULTIPLE`, not a hardcoded `10`, so the test that varies it keeps meaning something.
  The shape: `clamp01( log10(followers / reference) / log10(AUDIENCE_SATURATION_MULTIPLE) )`.
- **`detail` strings** are product copy, not decoration — they are what a creator reads to decide what to bid. Make them specific and numeric.

If you'd rather a different curve (linear-with-cap, a sigmoid, a piecewise band), the tests
that constrain you are `saturates audience fit`, `stays within 0..100`, and
`falls back to the baseline` — anything satisfying those is fair game. Tell me what you
picked and why, and I'll fold the reasoning into the README.

- [ ] **Step 5: Run the tests**

Run: `pnpm test -- matching`
Expected: all PASS (16 tests). If `has a total that equals the weighted sum` fails, the rounding is inconsistent between `total` and the components — round only at the end.

- [ ] **Step 6: Export and commit**

Add `export * from './matching.js'` to `packages/domain/src/index.ts`.

```bash
git add -A
git commit -m "feat(domain): eligibility gates and explainable fit score with saturating curves"
```

---

### Task 5: Winner selection — **YOU WRITE `selectWinners`**

**Files:**
- Create: `packages/domain/src/winners.ts`
- Test: `packages/domain/src/winners.test.ts`
- Modify: `packages/domain/src/index.ts`

**Interfaces:**
- Consumes: `Cents` from `./money.js`
- Produces:
  - `MIN_FIT_TO_WIN = 40`
  - `type BidCandidate = { id: string; creatorId: string; amountCents: number; fitScore: number; createdAt: Date }`
  - `type LossReason = 'below_quality_bar' | 'outranked' | 'did_not_fit_remaining_budget'`
  - `type BidOutcome = { bidId: string } & ({ won: true } | { won: false; reason: LossReason })`
  - `type SelectionResult = { outcomes: BidOutcome[]; winningBidIds: string[]; totalAwardedCents: number }`
  - `selectWinners(bids: readonly BidCandidate[], budgetCents: number): SelectionResult`
  - `compareBidsByValue(a: BidCandidate, b: BidCandidate): number`

- [ ] **Step 1: Write the types and the comparator**

`packages/domain/src/winners.ts`:
```ts
/**
 * A bid with fit *as snapshotted when it was placed*. The closer never
 * recomputes fit, which is what makes this function a pure function of
 * committed data — and therefore replayable.
 */
export type BidCandidate = {
  id: string
  creatorId: string
  amountCents: number
  /** 0..100, snapshotted at bid time. */
  fitScore: number
  createdAt: Date
}

/**
 * A bid below this cannot win at any price.
 *
 * Required, not optional: pure value-per-euro makes the cheapest junk win.
 * A fit-20 bid at €10 has density 2.0; a fit-90 bid at €1,000 has 0.09. Real
 * marketplaces work the same way — brands set a quality bar, then optimise
 * spend within it.
 *
 * Lives here as a constant rather than a campaigns column because no brand-side
 * UI exists yet to set it. Promoting it to a column is a migration plus reading
 * it from the row; nothing about this function changes.
 */
export const MIN_FIT_TO_WIN = 40

export type LossReason =
  | 'below_quality_bar'
  | 'outranked'
  | 'did_not_fit_remaining_budget'

export type BidOutcome =
  | { bidId: string; won: true }
  | { bidId: string; won: false; reason: LossReason }

export type SelectionResult = {
  /** One entry per input bid, in the order they were evaluated. */
  outcomes: BidOutcome[]
  winningBidIds: string[]
  totalAwardedCents: number
}

/** Value per cent of budget. Higher is better. */
export const valueDensity = (bid: BidCandidate): number => bid.fitScore / bid.amountCents

/**
 * A TOTAL order over bids. Every key after the first exists to make the sort
 * deterministic, which is what makes the closing job reproducible: an unstable
 * sort over equal-density bids could award different winners on a re-run, and
 * then "safe to run twice" would be false no matter how good the locking is.
 *
 *   1. density desc     — the economic rule
 *   2. fit desc         — at equal value, prefer quality
 *   3. createdAt asc    — reward committing early
 *   4. id asc           — arbitrary, but total. Never decides anything
 *                         meaningful, which is exactly why it must be here.
 */
export function compareBidsByValue(a: BidCandidate, b: BidCandidate): number {
  const byDensity = valueDensity(b) - valueDensity(a)
  if (byDensity !== 0) return byDensity

  const byFit = b.fitScore - a.fitScore
  if (byFit !== 0) return byFit

  const byAge = a.createdAt.getTime() - b.createdAt.getTime()
  if (byAge !== 0) return byAge

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}
```

- [ ] **Step 2: Write the failing test suite**

`packages/domain/src/winners.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { selectWinners, compareBidsByValue, MIN_FIT_TO_WIN, type BidCandidate } from './winners.js'

let seq = 0
const bid = (o: Partial<BidCandidate> = {}): BidCandidate => ({
  id: `bid-${String(++seq).padStart(4, '0')}`,
  creatorId: `creator-${seq}`,
  amountCents: 100_000,
  fitScore: 80,
  createdAt: new Date(2026, 0, 1, 0, 0, seq),
  ...o,
})

/** Deterministic shuffle so the determinism test is itself reproducible. */
function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items]
  let s = seed
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    const j = s % (i + 1)
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

const won = (r: ReturnType<typeof selectWinners>) => r.outcomes.filter((o) => o.won).map((o) => o.bidId)

describe('selectWinners', () => {
  it('returns an empty result for no bids', () => {
    const r = selectWinners([], 500_000)
    expect(r.outcomes).toEqual([])
    expect(r.winningBidIds).toEqual([])
    expect(r.totalAwardedCents).toBe(0)
  })

  it('produces exactly one outcome per input bid', () => {
    const bids = [bid(), bid(), bid({ fitScore: 10 })]
    const r = selectWinners(bids, 250_000)
    expect(r.outcomes).toHaveLength(3)
    expect(new Set(r.outcomes.map((o) => o.bidId))).toEqual(new Set(bids.map((b) => b.id)))
  })

  // The invariant the brief names explicitly.
  it('never exceeds the budget', () => {
    const bids = Array.from({ length: 30 }, () => bid({ amountCents: 90_000, fitScore: 70 }))
    const budget = 500_000
    const r = selectWinners(bids, budget)
    expect(r.totalAwardedCents).toBeLessThanOrEqual(budget)
    // Five at 90_000 is 450_000; a sixth would be 540_000. Pinning the count
    // stops this test from passing against an implementation that awards
    // nothing at all, which is trivially within budget.
    expect(won(r)).toHaveLength(5)
    expect(r.totalAwardedCents).toBe(
      r.outcomes.filter((o) => o.won)
        .reduce((sum, o) => sum + bids.find((b) => b.id === o.bidId)!.amountCents, 0),
    )
  })

  it('awards nothing when every bid alone exceeds the budget', () => {
    const r = selectWinners([bid({ amountCents: 900_000 }), bid({ amountCents: 800_000 })], 100_000)
    expect(won(r)).toEqual([])
    expect(r.totalAwardedCents).toBe(0)
    // Asserted before the .every() below, which is vacuously true on an empty
    // array — the assertion that matters is that both bids were *evaluated*.
    expect(r.outcomes).toHaveLength(2)
    expect(r.outcomes.every((o) => !o.won && o.reason === 'did_not_fit_remaining_budget')).toBe(true)
  })

  it('excludes bids below the quality bar at any price', () => {
    const cheapJunk = bid({ amountCents: 100, fitScore: MIN_FIT_TO_WIN - 1 })
    const solid     = bid({ amountCents: 200_000, fitScore: 90 })
    const r = selectWinners([cheapJunk, solid], 500_000)
    expect(won(r)).toEqual([solid.id])
    const junkOutcome = r.outcomes.find((o) => o.bidId === cheapJunk.id)!
    expect(junkOutcome).toEqual({ bidId: cheapJunk.id, won: false, reason: 'below_quality_bar' })
  })

  it('treats the quality bar as inclusive', () => {
    const atBar = bid({ fitScore: MIN_FIT_TO_WIN, amountCents: 10_000 })
    expect(won(selectWinners([atBar], 500_000))).toEqual([atBar.id])
  })

  it('prefers higher value per euro', () => {
    const efficient = bid({ amountCents: 100_000, fitScore: 90 })  // density 0.0009
    const expensive = bid({ amountCents: 400_000, fitScore: 95 })  // density 0.0002375
    const r = selectWinners([expensive, efficient], 100_000)
    expect(won(r)).toEqual([efficient.id])
  })

  // Spec §6.1 step 3: plain greedy stops at the first bid that doesn't fit,
  // leaving budget unspent for no reason.
  it('continues past an unaffordable bid instead of stopping', () => {
    const dense     = bid({ amountCents: 300_000, fitScore: 100 }) // best density, fits
    const tooBig    = bid({ amountCents: 250_000, fitScore: 80 })  // next best, will not fit
    const affordable = bid({ amountCents: 90_000, fitScore: 50 })  // worst density, fits
    const r = selectWinners([dense, tooBig, affordable], 400_000)
    expect(won(r)).toContain(dense.id)
    expect(won(r)).toContain(affordable.id)
    expect(won(r)).not.toContain(tooBig.id)
    expect(r.totalAwardedCents).toBe(390_000)
  })

  it('distinguishes "did not fit" from "outranked"', () => {
    const winner  = bid({ amountCents: 100_000, fitScore: 100 })
    const tooBig  = bid({ amountCents: 60_000, fitScore: 50 })
    const r = selectWinners([winner, tooBig], 100_000)
    const loser = r.outcomes.find((o) => o.bidId === tooBig.id)!
    // Budget was fully exhausted by the winner, so nothing remained at all.
    expect(loser).toEqual({ bidId: tooBig.id, won: false, reason: 'outranked' })
  })

  // THE test that makes "safe to run twice" true. See spec §6.5.
  it('is deterministic under any input ordering', () => {
    const bids = Array.from({ length: 24 }, (_, i) => bid({
      amountCents: 50_000 + (i % 6) * 10_000,
      // Deliberately collides on density for several pairs, forcing the
      // tie-breakers to do the work.
      fitScore: 40 + (i % 4) * 15,
    }))
    const baseline = selectWinners(bids, 400_000)
    for (const seed of [1, 2, 3, 7, 42, 1337]) {
      const r = selectWinners(shuffle(bids, seed), 400_000)
      expect(r.winningBidIds).toEqual(baseline.winningBidIds)
      expect(r.totalAwardedCents).toBe(baseline.totalAwardedCents)
    }
  })

  it('does not mutate its input', () => {
    const bids = [bid({ fitScore: 50 }), bid({ fitScore: 90 }), bid({ fitScore: 70 })]
    const before = bids.map((b) => b.id)
    selectWinners(bids, 500_000)
    expect(bids.map((b) => b.id)).toEqual(before)
  })

  it('rejects a non-positive budget rather than awarding for free', () => {
    expect(() => selectWinners([bid()], 0)).toThrow()
    expect(() => selectWinners([bid()], -1)).toThrow()
  })
})

describe('the documented worst case (spec §6.4)', () => {
  // Greedy density is not optimal. Pinning the known failure as a test means the
  // README's caveat is verified rather than asserted — and if someone later
  // swaps in a better algorithm, this test tells them the trade-off changed.
  it('takes both when the budget can hold both', () => {
    const tiny = bid({ amountCents: 100, fitScore: 41 })       // density 0.41
    const big  = bid({ amountCents: 100_000, fitScore: 100 })  // density 0.001
    // 100_100 exactly, not 100_000: the two bids together cost 100_100, so a
    // 100_000 budget cannot hold both and this would be testing the gap below
    // rather than continuation.
    const r = selectWinners([tiny, big], 100_100)
    expect(won(r)).toHaveLength(2)
    expect(r.totalAwardedCents).toBe(100_100)
  })

  it('leaves the budget almost untouched to buy one cheap bid — the greedy gap', () => {
    const r = selectWinners(
      [bid({ amountCents: 100, fitScore: 41 }), bid({ amountCents: 100_000, fitScore: 100 })],
      100_000,
    )
    // Greedy buys the €1 bid (fit 41) first on density, and then cannot afford
    // the €1,000 bid at all. The optimal allocation is the big bid alone:
    // fit 100 for the whole budget. This is the price of a rule creators can
    // reason about — see spec §6.2 — and it is pinned so the README's caveat is
    // verified rather than asserted.
    expect(r.winningBidIds).toHaveLength(1)
    expect(r.totalAwardedCents).toBe(100)
  })
})

describe('compareBidsByValue', () => {
  it('is a total order: no two distinct bids compare equal', () => {
    const bids = Array.from({ length: 40 }, (_, i) =>
      bid({ amountCents: 100_000, fitScore: 40 + (i % 3) * 20 }))
    for (const a of bids) for (const b of bids) {
      if (a.id !== b.id) expect(compareBidsByValue(a, b)).not.toBe(0)
    }
  })

  it('is antisymmetric', () => {
    const a = bid({ fitScore: 90 }), b = bid({ fitScore: 50 })
    expect(Math.sign(compareBidsByValue(a, b))).toBe(-Math.sign(compareBidsByValue(b, a)))
  })
})
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `pnpm test -- winners`
Expected: the `compareBidsByValue` tests PASS and nine `selectWinners` tests FAIL.

The stub returns no outcomes at all, which trivially satisfies "never exceeds the budget", "is deterministic", and "does not mutate its input" — and, before the length assertions were added, also satisfied "awards nothing when every bid alone exceeds the budget", because `[].every(...)` is `true`. Vacuous truth through `.every()` on a possibly-empty array is the most common way a green test suite proves nothing; both tests now assert the expected count first.

- [ ] **Step 4: 🧑 YOUR TURN — implement `selectWinners`**

Append to `packages/domain/src/winners.ts`:

```ts
/**
 * Chooses which bids win a campaign, subject to its budget.
 *
 * This is 0/1 knapsack. We deliberately do NOT solve it optimally — see spec
 * §6.2. Exact DP makes a creator's outcome depend combinatorially on every
 * other bid, so there is no threshold price and no advice you can give them.
 * Greedy value-density gives each creator a rule they can act on: improve your
 * fit or lower your price and your rank improves.
 *
 * Invariants this must uphold (all covered by tests):
 *   - sum of winning amounts <= budgetCents, always
 *   - exactly one outcome per input bid
 *   - identical output for any input permutation
 *   - input array is not mutated
 */
export function selectWinners(
  bids: readonly BidCandidate[],
  budgetCents: number,
): SelectionResult {
  if (!Number.isInteger(budgetCents) || budgetCents <= 0) {
    throw new Error(`budgetCents must be a positive integer, got ${budgetCents}`)
  }

  const outcomes: BidOutcome[] = []
  const winningBidIds: string[] = []
  let remaining = budgetCents

  // TODO(you): 1. partition out bids below MIN_FIT_TO_WIN, pushing a
  //               { won: false, reason: 'below_quality_bar' } outcome for each

  // TODO(you): 2. sort the survivors with compareBidsByValue
  //               (remember: do not mutate `bids`)

  // TODO(you): 3. walk the sorted list. For each bid:
  //               - fits in `remaining`  -> win, decrement remaining
  //               - remaining === 0      -> lose, 'outranked'
  //               - otherwise            -> lose, 'did_not_fit_remaining_budget'
  //                                         and CONTINUE to the next bid

  return {
    outcomes,
    winningBidIds,
    totalAwardedCents: budgetCents - remaining,
  }
}
```

**The decisions that are genuinely yours:**

1. **Loss-reason semantics.** I've proposed `remaining === 0 → 'outranked'`, otherwise `'did_not_fit_remaining_budget'`. Arguably a bid that lost while €400 remained but needed €1,200 was *also* outranked. The version I suggest gives the creator more actionable information ("there was budget left, your ask was too large" vs "the budget was gone"), which is why I'd keep them distinct — but if you think one reason is clearer product copy, collapse them and drop the corresponding test.

2. **Should a winner ever be partially awarded?** No — bids are all-or-nothing, which is why this is 0/1 knapsack rather than fractional. Worth knowing that fractional knapsack *is* optimally solved by exactly this greedy algorithm; the 0/1 constraint is the only reason greedy is approximate here. That is a nice line for the README.

3. **Order of `outcomes`.** The tests only require one entry per bid. Returning them in *evaluation* order (quality-bar failures first, then density order) means the array doubles as an audit trail of how the closer reasoned — which is what a `run_id`-driven debugging session wants to read. Returning them in input order would be more boring and equally valid.

**Watch out for:** `remaining` must be decremented only on a win, and `totalAwardedCents` is derived from it at the end rather than accumulated separately — two counters that can disagree is how a budget invariant silently breaks.

- [ ] **Step 5: Run the tests**

Run: `pnpm test -- winners`
Expected: all PASS (16 tests). Pay attention to two:
- `is deterministic under any input ordering` failing means the sort is not total — you're probably sorting on density alone somewhere.
- `does not mutate its input` failing means you called `.sort()` on `bids` directly instead of on a copy.

- [ ] **Step 6: Export and commit**

Add `export * from './winners.js'` to `packages/domain/src/index.ts`.

```bash
git add -A
git commit -m "feat(domain): greedy value-density winner selection with a total order and explained losses"
```

---

### Task 6: The closing worker — the correctness centrepiece

**Files:**
- Create: `apps/worker/src/config.ts`, `apps/worker/src/logger.ts`, `apps/worker/src/close-auctions.ts`, `apps/worker/src/main.ts`
- Test: `apps/worker/src/close-auctions.integration.test.ts`, `apps/worker/src/test-support/factories.ts`
- Modify: `apps/worker/package.json`

**Interfaces:**
- Consumes: `selectWinners`, `MIN_FIT_TO_WIN` from `@marketplace/domain`; `createDb`, `campaigns`, `bids`, `bidEvents`, `campaignClosings`, `closingRuns` from `@marketplace/db`.
- Produces:
  - `closeExpiredAuctions(db: Database, opts: CloseOptions): Promise<RunSummary>`
  - `type CloseOptions = { now?: Date; maxCampaigns?: number; logger?: Logger }`
  - `type RunSummary = { runId: string; campaignsClosed: number; bidsDecided: number; totalAwardedCents: number }`
  - npm scripts `start:once` and `start:loop`

- [ ] **Step 1: Write the test factories**

`apps/worker/src/test-support/factories.ts`:
```ts
import { createDb, campaigns, creators, bids, type Database } from '@marketplace/db'
import { randomUUID } from 'node:crypto'

export const testDbUrl = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL!

export async function truncateAll(db: Database) {
  // bid_events and campaign_closings cascade from bids/campaigns; closing_runs
  // is referenced by campaign_closings so it must be listed explicitly.
  await db.execute(
    `TRUNCATE bid_events, campaign_closings, bids, closing_runs, campaigns, creators CASCADE`,
  )
}

export async function makeCreator(db: Database, o: Partial<{
  genre: 'fitness' | 'food' | 'beauty' | 'gaming'; followerCount: number; engagementRate: string
}> = {}) {
  const [row] = await db.insert(creators).values({
    handle: `c-${randomUUID().slice(0, 8)}`,
    displayName: 'Test Creator',
    genre: o.genre ?? 'fitness',
    followerCount: o.followerCount ?? 100_000,
    engagementRate: o.engagementRate ?? '0.0400',
  }).returning()
  return row!
}

export async function makeCampaign(db: Database, o: Partial<{
  budgetCents: number; biddingDeadline: Date; status: 'open' | 'closed'
}> = {}) {
  const [row] = await db.insert(campaigns).values({
    brandName: 'Test Brand',
    title: 'Test Campaign',
    brief: 'Test brief',
    targetGenre: 'fitness',
    minFollowers: 10_000,
    minEngagementRate: '0.0200',
    budgetCents: o.budgetCents ?? 500_000,
    // Default is in the past so the campaign is immediately claimable.
    biddingDeadline: o.biddingDeadline ?? new Date(Date.now() - 60_000),
    status: o.status ?? 'open',
  }).returning()
  return row!
}

export async function makeBid(db: Database, campaignId: string, creatorId: string, o: Partial<{
  amountCents: number; fitScore: string; createdAt: Date
}> = {}) {
  const [row] = await db.insert(bids).values({
    campaignId, creatorId,
    amountCents: o.amountCents ?? 100_000,
    fitScore: o.fitScore ?? '80.00',
    ...(o.createdAt ? { createdAt: o.createdAt } : {}),
  }).returning()
  return row!
}

export const connect = () => createDb(testDbUrl, { max: 4 })
```

- [ ] **Step 2: Write the failing integration test suite**

`apps/worker/src/close-auctions.integration.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { bids, campaigns, campaignClosings, closingRuns, bidEvents } from '@marketplace/db'
import { closeExpiredAuctions } from './close-auctions.js'
import { connect, truncateAll, makeCreator, makeCampaign, makeBid } from './test-support/factories.js'

let ctx: ReturnType<typeof connect>

beforeAll(() => { ctx = connect() })
afterAll(async () => { await ctx.close() })
beforeEach(async () => { await truncateAll(ctx.db) })

/** Full state fingerprint, for asserting a re-run changes nothing. */
async function snapshot(db = ctx.db) {
  const [b, c, cl] = await Promise.all([
    db.select({ id: bids.id, status: bids.status, decidedAt: bids.decidedAt })
      .from(bids).orderBy(bids.id),
    db.select({ id: campaigns.id, status: campaigns.status }).from(campaigns).orderBy(campaigns.id),
    db.select().from(campaignClosings).orderBy(campaignClosings.campaignId),
  ])
  return { bids: b, campaigns: c, closings: cl }
}

describe('closeExpiredAuctions', () => {
  it('leaves a campaign whose deadline has not passed untouched', async () => {
    const creator = await makeCreator(ctx.db)
    const campaign = await makeCampaign(ctx.db, { biddingDeadline: new Date(Date.now() + 3_600_000) })
    await makeBid(ctx.db, campaign.id, creator.id)

    const summary = await closeExpiredAuctions(ctx.db, {})

    expect(summary.campaignsClosed).toBe(0)
    const [row] = await ctx.db.select().from(campaigns).where(eq(campaigns.id, campaign.id))
    expect(row!.status).toBe('open')
    const [b] = await ctx.db.select().from(bids)
    expect(b!.status).toBe('pending')
  })

  it('closes an expired campaign and awards winners within budget', async () => {
    const campaign = await makeCampaign(ctx.db, { budgetCents: 300_000 })
    const c1 = await makeCreator(ctx.db)
    const c2 = await makeCreator(ctx.db)
    const c3 = await makeCreator(ctx.db)
    await makeBid(ctx.db, campaign.id, c1.id, { amountCents: 100_000, fitScore: '90.00' })
    await makeBid(ctx.db, campaign.id, c2.id, { amountCents: 150_000, fitScore: '85.00' })
    await makeBid(ctx.db, campaign.id, c3.id, { amountCents: 200_000, fitScore: '50.00' })

    const summary = await closeExpiredAuctions(ctx.db, {})

    expect(summary.campaignsClosed).toBe(1)
    expect(summary.bidsDecided).toBe(3)
    expect(summary.totalAwardedCents).toBeLessThanOrEqual(300_000)

    const [closed] = await ctx.db.select().from(campaigns).where(eq(campaigns.id, campaign.id))
    expect(closed!.status).toBe('closed')

    const [closing] = await ctx.db.select().from(campaignClosings)
    expect(closing!.bidCount).toBe(3)
    expect(closing!.totalAwardedCents).toBe(summary.totalAwardedCents)
    expect(closing!.runId).toBe(summary.runId)

    const all = await ctx.db.select().from(bids)
    expect(all.every((b) => b.status === 'won' || b.status === 'lost')).toBe(true)
    expect(all.every((b) => b.decidedAt !== null)).toBe(true)
    const awarded = all.filter((b) => b.status === 'won').reduce((s, b) => s + b.amountCents, 0)
    expect(awarded).toBe(summary.totalAwardedCents)
  })

  // ── THE requirement from the brief ─────────────────────────────────────────
  it('is idempotent: a second run changes nothing', async () => {
    const campaign = await makeCampaign(ctx.db, { budgetCents: 250_000 })
    for (let i = 0; i < 5; i++) {
      const c = await makeCreator(ctx.db)
      await makeBid(ctx.db, campaign.id, c.id, {
        amountCents: 60_000 + i * 10_000, fitScore: String(50 + i * 10) + '.00',
      })
    }

    const first = await closeExpiredAuctions(ctx.db, {})
    const afterFirst = await snapshot()

    const second = await closeExpiredAuctions(ctx.db, {})
    const afterSecond = await snapshot()

    expect(second.campaignsClosed).toBe(0)
    expect(second.totalAwardedCents).toBe(0)
    expect(afterSecond).toEqual(afterFirst)

    // Exactly one closing row, and no duplicate won/lost events.
    const closings = await ctx.db.select().from(campaignClosings)
    expect(closings).toHaveLength(1)
    const decisionEvents = await ctx.db.select().from(bidEvents)
      .where(sql`${bidEvents.type} IN ('won','lost')`)
    expect(decisionEvents).toHaveLength(5)
    expect(first.campaignsClosed).toBe(1)
  })

  it('is safe under two workers running concurrently', async () => {
    const campaign = await makeCampaign(ctx.db, { budgetCents: 200_000 })
    for (let i = 0; i < 6; i++) {
      const c = await makeCreator(ctx.db)
      await makeBid(ctx.db, campaign.id, c.id, { amountCents: 50_000, fitScore: String(60 + i) + '.00' })
    }

    // Separate connection pools, so these genuinely contend in Postgres.
    const other = connect()
    try {
      const [a, b] = await Promise.all([
        closeExpiredAuctions(ctx.db, {}),
        closeExpiredAuctions(other.db, {}),
      ])
      // Exactly one of them did the work; the other found nothing (SKIP LOCKED).
      expect(a.campaignsClosed + b.campaignsClosed).toBe(1)
    } finally {
      await other.close()
    }

    const closings = await ctx.db.select().from(campaignClosings)
    expect(closings).toHaveLength(1)
    expect(closings[0]!.totalAwardedCents).toBeLessThanOrEqual(200_000)

    const awarded = (await ctx.db.select().from(bids))
      .filter((b) => b.status === 'won')
      .reduce((s, b) => s + b.amountCents, 0)
    expect(awarded).toBeLessThanOrEqual(200_000)
  })

  it('closes a campaign with zero bids, recording an empty result', async () => {
    const campaign = await makeCampaign(ctx.db)
    const summary = await closeExpiredAuctions(ctx.db, {})

    expect(summary.campaignsClosed).toBe(1)
    expect(summary.bidsDecided).toBe(0)
    const [closing] = await ctx.db.select().from(campaignClosings)
    expect(closing!.bidCount).toBe(0)
    expect(closing!.winningBidCount).toBe(0)
    expect(closing!.totalAwardedCents).toBe(0)
    const [c] = await ctx.db.select().from(campaigns).where(eq(campaigns.id, campaign.id))
    expect(c!.status).toBe('closed')
  })

  it('ignores withdrawn bids', async () => {
    const campaign = await makeCampaign(ctx.db, { budgetCents: 500_000 })
    const c1 = await makeCreator(ctx.db)
    const c2 = await makeCreator(ctx.db)
    const active = await makeBid(ctx.db, campaign.id, c1.id, { amountCents: 100_000, fitScore: '90.00' })
    const gone = await makeBid(ctx.db, campaign.id, c2.id, { amountCents: 50_000, fitScore: '95.00' })
    await ctx.db.update(bids).set({ status: 'withdrawn' }).where(eq(bids.id, gone.id))

    const summary = await closeExpiredAuctions(ctx.db, {})

    expect(summary.bidsDecided).toBe(1)
    const [stillWithdrawn] = await ctx.db.select().from(bids).where(eq(bids.id, gone.id))
    expect(stillWithdrawn!.status).toBe('withdrawn')
    expect(stillWithdrawn!.decidedAt).toBeNull()
    const [won] = await ctx.db.select().from(bids).where(eq(bids.id, active.id))
    expect(won!.status).toBe('won')
  })

  it('records a run with a finish time and matching totals', async () => {
    await makeCampaign(ctx.db)
    const summary = await closeExpiredAuctions(ctx.db, {})

    const [run] = await ctx.db.select().from(closingRuns).where(eq(closingRuns.id, summary.runId))
    expect(run!.finishedAt).not.toBeNull()
    expect(run!.campaignsClosed).toBe(summary.campaignsClosed)
    expect(run!.totalAwardedCents).toBe(summary.totalAwardedCents)
    expect(run!.error).toBeNull()
  })

  it('writes a loss reason on every losing bid, attributed to the run', async () => {
    const campaign = await makeCampaign(ctx.db, { budgetCents: 100_000 })
    const c1 = await makeCreator(ctx.db)
    const c2 = await makeCreator(ctx.db)
    await makeBid(ctx.db, campaign.id, c1.id, { amountCents: 100_000, fitScore: '95.00' })
    const loser = await makeBid(ctx.db, campaign.id, c2.id, { amountCents: 90_000, fitScore: '45.00' })

    const summary = await closeExpiredAuctions(ctx.db, {})

    const events = await ctx.db.select().from(bidEvents).where(eq(bidEvents.bidId, loser.id))
    const lost = events.find((e) => e.type === 'lost')!
    expect(lost.actor).toBe('closer')
    expect(lost.runId).toBe(summary.runId)
    expect(typeof (lost.metadata as { reason?: string }).reason).toBe('string')
  })

  it('honours maxCampaigns so one run cannot monopolise the worker', async () => {
    for (let i = 0; i < 4; i++) await makeCampaign(ctx.db)
    const summary = await closeExpiredAuctions(ctx.db, { maxCampaigns: 2 })
    expect(summary.campaignsClosed).toBe(2)

    const remaining = await ctx.db.select().from(campaigns).where(eq(campaigns.status, 'open'))
    expect(remaining).toHaveLength(2)
  })

  it('closes campaigns in deadline order, oldest first', async () => {
    const newer = await makeCampaign(ctx.db, { biddingDeadline: new Date(Date.now() - 10_000) })
    const older = await makeCampaign(ctx.db, { biddingDeadline: new Date(Date.now() - 600_000) })
    await closeExpiredAuctions(ctx.db, { maxCampaigns: 1 })

    const [o] = await ctx.db.select().from(campaigns).where(eq(campaigns.id, older.id))
    const [n] = await ctx.db.select().from(campaigns).where(eq(campaigns.id, newer.id))
    expect(o!.status).toBe('closed')
    expect(n!.status).toBe('open')
  })
})
```

- [ ] **Step 3: Run and confirm failure**

Run: `pnpm test:integration -- close-auctions`
Expected: FAIL — `close-auctions.js` not found.

- [ ] **Step 4: Implement config and logger**

`apps/worker/src/config.ts`:
```ts
import { z } from 'zod'

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  CLOSE_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
  MAX_CAMPAIGNS_PER_RUN: z.coerce.number().int().positive().default(50),
  // 'silent' included so the same LOG_LEVEL value is valid for both services;
  // compose sets one variable, and pino accepts it in either.
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
})

export type WorkerConfig = z.infer<typeof schema>

/** Fails fast at boot with every problem listed, not one at a time. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    throw new Error(`invalid worker configuration:\n${formatIssues(parsed.error)}`)
  }
  return parsed.data
}
```

`apps/worker/src/logger.ts`:
```ts
import pino from 'pino'

export type Logger = pino.Logger

export const createLogger = (level: string): Logger =>
  pino({ level, base: { service: 'worker' } })
```

- [ ] **Step 5: Implement the closer**

`apps/worker/src/close-auctions.ts`:
```ts
import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm'
import {
  bids, bidEvents, campaigns, campaignClosings, closingRuns, type Database,
} from '@marketplace/db'
import {
  selectWinners as defaultSelectWinners,
  type BidCandidate, type SelectionResult,
} from '@marketplace/domain'
import pino from 'pino'
import type { Logger } from './logger.js'

/** The selection rule the closer applies. Exactly `selectWinners`' signature. */
export type SelectWinnersFn = (
  bids: readonly BidCandidate[],
  budgetCents: number,
) => SelectionResult

export type CloseOptions = {
  /** Injected so tests can control the cutoff. Defaults to wall clock. */
  now?: Date
  maxCampaigns?: number
  logger?: Logger
  /**
   * Injected only by tests, to drive the assertions below with a deliberately
   * broken rule. Production never passes this: the default is the domain
   * function, so there is one selection implementation, not two.
   */
  selectWinners?: SelectWinnersFn
}

export type RunSummary = {
  runId: string
  campaignsClosed: number
  bidsDecided: number
  totalAwardedCents: number
}

/**
 * Closes every campaign whose bidding deadline has passed, selecting winners
 * within budget. Safe to run concurrently with itself and safe to re-run.
 *
 * Correctness rests on five layers (spec §7.2), not on this function being
 * called carefully:
 *   L1  claim with FOR UPDATE SKIP LOCKED, inside the closing transaction
 *   L2  `status = 'open'` evaluated under the lock is the idempotency guard
 *   L3  one transaction per campaign, so a crash rolls back cleanly
 *   L4  campaign_closings.campaign_id is a PK, so a double close cannot commit
 *   L5  the budget assertion before commit
 *   L6  the completeness assertion: every pending bid leaves with a decision
 */
export async function closeExpiredAuctions(
  db: Database,
  {
    now, maxCampaigns = 50, logger = pino({ enabled: false }),
    selectWinners = defaultSelectWinners,
  }: CloseOptions,
): Promise<RunSummary> {
  // Committed in its own transaction, before any campaign work, so the
  // per-campaign rows can reference it. A crash therefore leaves
  // finished_at IS NULL — which is the signal, not a gap.
  const [run] = await db.insert(closingRuns).values({}).returning()
  const runId = run!.id
  const log = logger.child({ runId })

  let campaignsClosed = 0
  let bidsDecided = 0
  let totalAwardedCents = 0

  try {
    for (let i = 0; i < maxCampaigns; i++) {
      const result = await closeOneCampaign(db, { runId, now, log, selectWinners })
      if (!result) break
      campaignsClosed += 1
      bidsDecided += result.bidsDecided
      totalAwardedCents += result.awardedCents
    }

    await db.update(closingRuns)
      .set({ finishedAt: new Date(), campaignsClosed, bidsDecided, totalAwardedCents })
      .where(eq(closingRuns.id, runId))

    log.info({ campaignsClosed, bidsDecided, totalAwardedCents }, 'closing run finished')
  } catch (error) {
    // Record the failure on the run row so a crashed run is diagnosable from
    // the database, then rethrow — the caller decides whether to exit non-zero.
    await db.update(closingRuns)
      .set({ finishedAt: new Date(), campaignsClosed, bidsDecided, totalAwardedCents,
             error: error instanceof Error ? error.message : String(error) })
      .where(eq(closingRuns.id, runId))
      .catch(() => { /* the original error matters more than this update */ })
    log.error({ err: error }, 'closing run failed')
    throw error
  }

  return { runId, campaignsClosed, bidsDecided, totalAwardedCents }
}

type OneResult = { bidsDecided: number; awardedCents: number }

/**
 * Claims and closes at most one campaign, atomically. Returns null when there
 * is nothing left to claim.
 *
 * The claim and the close MUST share a transaction: a row lock lives exactly as
 * long as the transaction that took it, so claiming a batch in one transaction
 * and closing each in another would release every lock before any work happened.
 */
async function closeOneCampaign(
  db: Database,
  // `now: Date | undefined`, not `now?: Date`. Under exactOptionalPropertyTypes
  // those differ: the public CloseOptions may omit the key, but this internal
  // call always passes it, possibly holding undefined. Saying so is the honest
  // signature rather than widening the caller.
  { runId, now, log, selectWinners }: {
    runId: string; now: Date | undefined; log: Logger; selectWinners: SelectWinnersFn
  },
): Promise<OneResult | null> {
  return db.transaction(async (tx) => {
    const cutoff = now ?? new Date()

    const claimed = await tx.select().from(campaigns)
      .where(and(eq(campaigns.status, 'open'), lte(campaigns.biddingDeadline, cutoff)))
      .orderBy(asc(campaigns.biddingDeadline), asc(campaigns.id))
      .limit(1)
      .for('update', { skipLocked: true })

    const campaign = claimed[0]
    if (!campaign) return null

    const pending = await tx.select().from(bids)
      .where(and(eq(bids.campaignId, campaign.id), eq(bids.status, 'pending')))
      .orderBy(asc(bids.id))

    const candidates: BidCandidate[] = pending.map((b) => ({
      id: b.id,
      creatorId: b.creatorId,
      amountCents: b.amountCents,
      // NUMERIC arrives as a string from the driver; the snapshot is authoritative.
      fitScore: Number(b.fitScore),
      createdAt: b.createdAt,
    }))

    const selection = candidates.length > 0
      ? selectWinners(candidates, campaign.budgetCents)
      : { outcomes: [], winningBidIds: [], totalAwardedCents: 0 }

    // L6: every pending bid must receive a decision. Without this a buggy
    // selectWinners that drops bids would close the campaign and leave those
    // bids `pending` forever — invisible, un-actionable, and unrecoverable
    // because the campaign is no longer claimable. Found by running the closer
    // against a stub selection that returned no outcomes: the campaign closed
    // with bid_count 4 and four bids still pending.
    if (selection.outcomes.length !== candidates.length) {
      throw new Error(
        `selection did not decide every bid for campaign ${campaign.id}: ` +
        `${selection.outcomes.length} outcomes for ${candidates.length} pending bids`,
      )
    }

    // L5: refuse to commit rather than overspend. A throw here rolls the whole
    // transaction back and leaves the campaign open for the next run.
    if (selection.totalAwardedCents > campaign.budgetCents) {
      throw new Error(
        `budget invariant violated for campaign ${campaign.id}: ` +
        `awarded ${selection.totalAwardedCents} > budget ${campaign.budgetCents}`,
      )
    }

    const decidedAt = new Date()

    for (const outcome of selection.outcomes) {
      await tx.update(bids)
        .set({ status: outcome.won ? 'won' : 'lost', decidedAt, updatedAt: decidedAt })
        .where(eq(bids.id, outcome.bidId))

      const bid = pending.find((b) => b.id === outcome.bidId)!
      await tx.insert(bidEvents).values({
        bidId: outcome.bidId,
        type: outcome.won ? 'won' : 'lost',
        amountCents: bid.amountCents,
        fitScore: bid.fitScore,
        actor: 'closer',
        runId,
        metadata: outcome.won
          ? { awardedCents: bid.amountCents }
          : { reason: outcome.reason },
      })
    }

    await tx.update(campaigns).set({ status: 'closed' }).where(eq(campaigns.id, campaign.id))

    // L4: PK on campaign_id. If a concurrent worker somehow got this far too,
    // this insert raises a unique violation and the transaction aborts.
    await tx.insert(campaignClosings).values({
      campaignId: campaign.id,
      runId,
      bidCount: candidates.length,
      winningBidCount: selection.winningBidIds.length,
      totalAwardedCents: selection.totalAwardedCents,
    })

    log.info({
      campaignId: campaign.id, bidCount: candidates.length,
      winners: selection.winningBidIds.length,
      awardedCents: selection.totalAwardedCents, budgetCents: campaign.budgetCents,
    }, 'campaign closed')

    return { bidsDecided: candidates.length, awardedCents: selection.totalAwardedCents }
  })
}
```

- [ ] **Step 6: Implement the two run modes**

`apps/worker/src/main.ts`:
```ts
import { createDb } from '@marketplace/db'
import { loadConfig } from './config.js'
import { createLogger } from './logger.js'
import { closeExpiredAuctions } from './close-auctions.js'

const mode = process.argv.includes('--loop') ? 'loop' : 'once'
const config = loadConfig()
const logger = createLogger(config.LOG_LEVEL)
const { db, close } = createDb(config.DATABASE_URL, { max: 4 })

const runOnce = () =>
  closeExpiredAuctions(db, { maxCampaigns: config.MAX_CAMPAIGNS_PER_RUN, logger })

if (mode === 'once') {
  // Exactly a Kubernetes CronJob entrypoint: one pass, then exit with a
  // meaningful status code. Safe to run repeatedly by construction.
  try {
    await runOnce()
    await close()
    process.exit(0)
  } catch {
    await close()
    process.exit(1)
  }
} else {
  logger.info({ intervalMs: config.CLOSE_INTERVAL_MS }, 'worker started in loop mode')
  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    logger.info('shutting down')
    await close()
    process.exit(0)
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)

  while (!stopping) {
    // A failed pass must not kill the loop: the next tick retries, and
    // idempotency means a partial failure costs nothing.
    await runOnce().catch((err) => logger.error({ err }, 'pass failed, continuing'))
    await new Promise((r) => setTimeout(r, config.CLOSE_INTERVAL_MS))
  }
}
```

Add to `apps/worker/package.json`:
```json
{
  "name": "@marketplace/worker",
  "private": true,
  "type": "module",
  "scripts": {
    "start:once": "tsx src/main.ts --once",
    "start:loop": "tsx src/main.ts --loop"
  },
  "dependencies": {
    "@marketplace/db": "workspace:*",
    "@marketplace/domain": "workspace:*",
    "drizzle-orm": "^0.38.0",
    "pino": "^9.5.0",
    "zod": "^3.24.0"
  }
}
```

- [ ] **Step 7: Run the integration suite**

Run: `pnpm test:integration -- close-auctions`
Expected: all 10 PASS.

Debugging notes if they don't:
- *`is idempotent` fails with a duplicate-key error rather than a clean no-op* → the `status = 'open'` predicate is missing from the claim query, so L2 isn't guarding and you're relying on L4 to catch it. L4 is a backstop, not the mechanism.
- *`safe under two workers` sees `campaignsClosed` sum to 2* → `skipLocked` isn't being applied, or both calls share one connection pool and were serialised by the pool rather than by Postgres.
- *`ignores withdrawn bids` fails* → the pending-bid query is missing `eq(bids.status, 'pending')`.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(worker): idempotent auction closing with claim-one-per-transaction locking"
```

---

### Task 7: Seed data and bootstrap

**Files:**
- Create: `packages/db/src/fixtures.ts`, `packages/db/src/seed.ts`

**Interfaces:**
- Consumes: `scoreFit`, `GENRES` from `@marketplace/domain`; schema tables.
- Produces: `pnpm db:seed`, and `pnpm bootstrap` (migrate → seed → `worker --once`).

- [ ] **Step 1: Write the fixtures**

`packages/db/src/fixtures.ts` — fixed UUIDs so the seed is idempotent and so demo links are stable across resets.

```ts
import type { Genre } from '@marketplace/domain'

/** Minutes from seed time, so the demo has the right shape whenever it runs. */
export type DeadlineOffsetMinutes = number

export const CREATOR_FIXTURES: ReadonlyArray<{
  id: string; handle: string; displayName: string; genre: Genre
  followerCount: number; engagementRate: string; statsAgeHours: number
}> = [
  { id: '11111111-0000-4000-8000-000000000001', handle: '@mia.beats',      displayName: 'Mia Bekker',      genre: 'music',   followerCount: 412_000, engagementRate: '0.0620', statsAgeHours: 2 },
  { id: '11111111-0000-4000-8000-000000000002', handle: '@liftwithlena',   displayName: 'Lena Fischer',    genre: 'fitness', followerCount: 128_000, engagementRate: '0.0780', statsAgeHours: 1 },
  { id: '11111111-0000-4000-8000-000000000003', handle: '@glowbyjo',       displayName: 'Johanna Weiss',   genre: 'beauty',  followerCount: 890_000, engagementRate: '0.0210', statsAgeHours: 6 },
  { id: '11111111-0000-4000-8000-000000000004', handle: '@kitchen.kai',    displayName: 'Kai Nowak',       genre: 'food',    followerCount: 34_000,  engagementRate: '0.0710', statsAgeHours: 3 },
  { id: '11111111-0000-4000-8000-000000000005', handle: '@pixelpatrick',   displayName: 'Patrick Adeyemi', genre: 'gaming',  followerCount: 1_240_000, engagementRate: '0.0150', statsAgeHours: 12 },
  { id: '11111111-0000-4000-8000-000000000006', handle: '@sofi.styles',    displayName: 'Sofia Rossi',     genre: 'fashion', followerCount: 61_000,  engagementRate: '0.0440', statsAgeHours: 4 },
  { id: '11111111-0000-4000-8000-000000000007', handle: '@tinytechtom',    displayName: 'Tom Haverkamp',   genre: 'tech',    followerCount: 12_400,  engagementRate: '0.0530', statsAgeHours: 8 },
  { id: '11111111-0000-4000-8000-000000000008', handle: '@wander.with.wu', displayName: 'Wen Wu',          genre: 'travel',  followerCount: 205_000, engagementRate: '0.0110', statsAgeHours: 30 },
]

export const CAMPAIGN_FIXTURES: ReadonlyArray<{
  id: string; brandName: string; title: string; brief: string; targetGenre: Genre
  minFollowers: number; minEngagementRate: string; budgetCents: number
  deadlineOffsetMinutes: DeadlineOffsetMinutes
}> = [
  // ── Already past deadline: the bootstrap's `worker --once` settles these, so
  //    won/lost state is visible on first page load.
  { id: '22222222-0000-4000-8000-000000000001', brandName: "L'Oréal Paris", title: 'Summer Glow launch',        brief: 'Three-part story series featuring the new Summer Glow serum.', targetGenre: 'beauty',  minFollowers: 50_000,  minEngagementRate: '0.0150', budgetCents: 1_200_000, deadlineOffsetMinutes: -240 },
  { id: '22222222-0000-4000-8000-000000000002', brandName: 'Sony Music',    title: 'Album drop amplification',  brief: 'Use the lead single in one Reel plus one feed post.',           targetGenre: 'music',   minFollowers: 100_000, minEngagementRate: '0.0200', budgetCents: 800_000,   deadlineOffsetMinutes: -180 },
  // ── Past deadline but NOT closed by bootstrap: shows the "results pending"
  //    state. Deadline is set just before now, and bootstrap runs before it lapses.
  { id: '22222222-0000-4000-8000-000000000003', brandName: 'ABOUT YOU',     title: 'Autumn capsule try-on',     brief: 'Try-on haul of six autumn pieces, your styling.',               targetGenre: 'fashion', minFollowers: 25_000,  minEngagementRate: '0.0200', budgetCents: 600_000,   deadlineOffsetMinutes: 2 },
  // ── Closing soon: the reviewer can bid and watch it settle.
  { id: '22222222-0000-4000-8000-000000000004', brandName: 'Zalando',       title: 'Sneaker week teaser',       brief: 'One unboxing Reel before Sneaker Week.',                        targetGenre: 'fashion', minFollowers: 10_000,  minEngagementRate: '0.0100', budgetCents: 450_000,   deadlineOffsetMinutes: 6 },
  { id: '22222222-0000-4000-8000-000000000005', brandName: 'HelloFresh',    title: 'Weeknight recipe series',   brief: 'Three recipes using the autumn box.',                           targetGenre: 'food',    minFollowers: 20_000,  minEngagementRate: '0.0300', budgetCents: 700_000,   deadlineOffsetMinutes: 12 },
  // ── Comfortably open.
  { id: '22222222-0000-4000-8000-000000000006', brandName: 'Gymshark',      title: 'Winter training push',      brief: 'Four-week training series in the new range.',                   targetGenre: 'fitness', minFollowers: 75_000,  minEngagementRate: '0.0400', budgetCents: 1_500_000, deadlineOffsetMinutes: 2_880 },
  { id: '22222222-0000-4000-8000-000000000007', brandName: 'Logitech G',    title: 'Peripheral review drop',    brief: 'Honest review of the new keyboard and mouse.',                  targetGenre: 'gaming',  minFollowers: 200_000, minEngagementRate: '0.0100', budgetCents: 950_000,   deadlineOffsetMinutes: 4_320 },
  { id: '22222222-0000-4000-8000-000000000008', brandName: 'Flixbus',       title: 'City-hop challenge',        brief: 'Three cities in one weekend, on a budget.',                     targetGenre: 'travel',  minFollowers: 0,       minEngagementRate: '0.0000', budgetCents: 300_000,   deadlineOffsetMinutes: 7_200 },
  { id: '22222222-0000-4000-8000-000000000009', brandName: 'Nothing',       title: 'Phone (3) first look',      brief: 'First-look video within 24h of embargo lift.',                  targetGenre: 'tech',    minFollowers: 10_000,  minEngagementRate: '0.0450', budgetCents: 550_000,   deadlineOffsetMinutes: 5_760 },
  { id: '22222222-0000-4000-8000-00000000000a', brandName: 'Oatly',         title: 'Barista edition tasting',   brief: 'Coffee-shop style taste test.',                                 targetGenre: 'food',    minFollowers: 500_000, minEngagementRate: '0.0500', budgetCents: 400_000,   deadlineOffsetMinutes: 8_640 },
]

/**
 * Bids on the two already-expired campaigns, so the budget genuinely binds and
 * the greedy rule visibly rejects someone. Amounts chosen so campaign 1's
 * €12,000 budget cannot cover all four bids.
 */
export const BID_FIXTURES: ReadonlyArray<{
  campaignId: string; creatorId: string; amountCents: number; pitch: string
}> = [
  { campaignId: '22222222-0000-4000-8000-000000000001', creatorId: '11111111-0000-4000-8000-000000000003', amountCents: 550_000, pitch: 'Serum fits my skincare series exactly.' },
  { campaignId: '22222222-0000-4000-8000-000000000001', creatorId: '11111111-0000-4000-8000-000000000006', amountCents: 400_000, pitch: 'Beauty-adjacent fashion audience, high save rate.' },
  { campaignId: '22222222-0000-4000-8000-000000000001', creatorId: '11111111-0000-4000-8000-000000000002', amountCents: 380_000, pitch: 'Post-workout glow angle.' },
  { campaignId: '22222222-0000-4000-8000-000000000001', creatorId: '11111111-0000-4000-8000-000000000001', amountCents: 260_000, pitch: 'Can pair with a track release.' },
  { campaignId: '22222222-0000-4000-8000-000000000002', creatorId: '11111111-0000-4000-8000-000000000001', amountCents: 420_000, pitch: 'Lead single already in my rotation.' },
  { campaignId: '22222222-0000-4000-8000-000000000002', creatorId: '11111111-0000-4000-8000-000000000005', amountCents: 500_000, pitch: 'Gaming crossover, music in streams.' },
]
```

- [ ] **Step 2: Write the seed script**

`packages/db/src/seed.ts`:
```ts
import { scoreFit } from '@marketplace/domain'
import { createDb } from './client.js'
import { bidEvents, bids, campaignClosings, campaigns, closingRuns, creators } from './schema.js'
import { BID_FIXTURES, CAMPAIGN_FIXTURES, CREATOR_FIXTURES } from './fixtures.js'

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is required')
const reset = process.argv.includes('--reset')

const { db, close } = createDb(url, { max: 1 })
const now = Date.now()

if (reset) {
  await db.execute(
    `TRUNCATE bid_events, campaign_closings, bids, closing_runs, campaigns, creators CASCADE`,
  )
  console.log('truncated')
}

await db.insert(creators).values(CREATOR_FIXTURES.map((c) => ({
  id: c.id, handle: c.handle, displayName: c.displayName, genre: c.genre,
  followerCount: c.followerCount, engagementRate: c.engagementRate,
  statsUpdatedAt: new Date(now - c.statsAgeHours * 3_600_000),
}))).onConflictDoNothing()

await db.insert(campaigns).values(CAMPAIGN_FIXTURES.map((c) => ({
  id: c.id, brandName: c.brandName, title: c.title, brief: c.brief,
  targetGenre: c.targetGenre, minFollowers: c.minFollowers,
  minEngagementRate: c.minEngagementRate, budgetCents: c.budgetCents,
  biddingDeadline: new Date(now + c.deadlineOffsetMinutes * 60_000),
}))).onConflictDoNothing()

// fit_score is snapshotted here using the same domain function the API uses, so
// seeded bids are indistinguishable from bids placed through the UI.
const creatorById = new Map(CREATOR_FIXTURES.map((c) => [c.id, c]))
const campaignById = new Map(CAMPAIGN_FIXTURES.map((c) => [c.id, c]))

const bidRows = BID_FIXTURES.map((b) => {
  const creator = creatorById.get(b.creatorId)!
  const campaign = campaignById.get(b.campaignId)!
  const fit = scoreFit(
    { genre: creator.genre, followerCount: creator.followerCount,
      engagementRate: Number(creator.engagementRate) },
    { targetGenre: campaign.targetGenre, minFollowers: campaign.minFollowers,
      minEngagementRate: Number(campaign.minEngagementRate) },
  )
  return {
    campaignId: b.campaignId, creatorId: b.creatorId,
    amountCents: b.amountCents, fitScore: fit.total.toFixed(2), pitch: b.pitch,
  }
})

const inserted = await db.insert(bids).values(bidRows).onConflictDoNothing().returning()

if (inserted.length > 0) {
  await db.insert(bidEvents).values(inserted.map((b) => ({
    bidId: b.id, type: 'placed' as const, amountCents: b.amountCents,
    fitScore: b.fitScore, actor: 'creator', metadata: { source: 'seed' },
  })))
}

await close()
console.log(
  `seeded ${CREATOR_FIXTURES.length} creators, ${CAMPAIGN_FIXTURES.length} campaigns, ` +
  `${inserted.length} bids (all pending)`,
)
console.log('run `pnpm --filter @marketplace/worker start:once` to settle expired auctions')
```

★ Why the seed does **not** write `won`/`lost` rows itself: that would be a second implementation of winner selection living in seed code, free to drift from the real one. Instead `pnpm bootstrap` runs `db:migrate && db:seed && worker --once`, so the seeded closed auctions are by construction exactly what the production code path produces — and seeding doubles as a smoke test of the closer on every fresh boot.

- [ ] **Step 3: Run the bootstrap and verify**

Run:
```bash
pnpm bootstrap
psql "$DATABASE_URL" -c "SELECT c.title, c.status, cl.winning_bid_count, cl.total_awarded_cents, c.budget_cents
                         FROM campaigns c LEFT JOIN campaign_closings cl ON cl.campaign_id = c.id
                         ORDER BY c.bidding_deadline"
```
Expected: the two `-240`/`-180` campaigns are `closed` with `winning_bid_count >= 1` and `total_awarded_cents <= budget_cents`; every other campaign is `open`.

- [ ] **Step 4: Verify idempotency of the whole bootstrap**

Run: `pnpm bootstrap && pnpm bootstrap`
Expected: identical output, no duplicate-key errors, and still exactly 2 rows in `campaign_closings`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(db): idempotent seed; bootstrap settles expired auctions via the real closer"
```

---

### Task 8: API skeleton — config, context, errors, health

**Files:**
- Create: `apps/api/src/config.ts`, `apps/api/src/app.ts`, `apps/api/src/server.ts`
- Create: `apps/api/src/plugins/{db,creator-context,error-handler}.ts`
- Create: `apps/api/src/routes/health.ts`
- Create: `apps/api/src/errors.ts`
- Test: `apps/api/src/app.test.ts`

**Interfaces:**
- Produces: `buildApp(deps: { db: Database; config: ApiConfig }): FastifyInstance`, `AppError`, and `request.creator: Creator` on every route outside `/api/health` and `/api/creators`.

- [ ] **Step 1: Write the error model**

`apps/api/src/errors.ts`:
```ts
/**
 * Every failure the client is meant to handle is an AppError with a stable
 * `code`. The UI maps codes to copy; it never parses messages. Anything that
 * is not an AppError is a bug and becomes a 500 with no detail leaked.
 */
export class AppError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    readonly statusCode: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export type ApiErrorCode =
  | 'CREATOR_REQUIRED'      // 400 — no X-Creator-Id header
  | 'CREATOR_NOT_FOUND'     // 404
  | 'CAMPAIGN_NOT_FOUND'    // 404
  | 'CAMPAIGN_NOT_BIDDABLE' // 409 — closed, or deadline passed
  | 'CREATOR_INELIGIBLE'    // 422 — fails a hard gate
  | 'BID_EXCEEDS_BUDGET'    // 422 — could never win, so refuse it
  | 'BID_NOT_FOUND'         // 404
  | 'NOT_BID_OWNER'         // 403
  | 'BID_NOT_EDITABLE'      // 409 — already decided
  | 'VALIDATION_FAILED'     // 400
  | 'DEV_TOOLS_DISABLED'    // 404

export const badRequest = (code: ApiErrorCode, msg: string, details?: unknown) =>
  new AppError(code, 400, msg, details)
export const notFound = (code: ApiErrorCode, msg: string) => new AppError(code, 404, msg)
export const conflict = (code: ApiErrorCode, msg: string) => new AppError(code, 409, msg)
export const unprocessable = (code: ApiErrorCode, msg: string, details?: unknown) =>
  new AppError(code, 422, msg, details)
```

- [ ] **Step 2: Write the config**

`apps/api/src/config.ts`:
```ts
import { z } from 'zod'

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  // Defaults false so the flag fails in the safe direction. Only compose sets it.
  ENABLE_DEV_TOOLS: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
})

export type ApiConfig = z.infer<typeof schema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = schema.safeParse(env)
  if (!parsed.success) throw new Error(`invalid API configuration:\n${formatIssues(parsed.error)}`)
  return parsed.data
}
```

- [ ] **Step 3: Write the creator-context plugin**

`apps/api/src/plugins/creator-context.ts`:
```ts
import fp from 'fastify-plugin'
import { eq } from 'drizzle-orm'
import { creators, type Creator } from '@marketplace/db'
import { AppError } from '../errors.js'

declare module 'fastify' {
  interface FastifyRequest { creator: Creator }
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
```

- [ ] **Step 4: Write the db plugin, error handler, health route and app factory**

`apps/api/src/plugins/db.ts`:
```ts
import fp from 'fastify-plugin'
import type { Database } from '@marketplace/db'

declare module 'fastify' {
  interface FastifyInstance { db: Database }
}

export default fp<{ db: Database }>(async (app, opts) => {
  app.decorate('db', opts.db)
})
```

`apps/api/src/plugins/error-handler.ts`:
```ts
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
    // carries `issues`, a Fastify schema failure carries `validation`.
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
```

`apps/api/src/routes/health.ts`:
```ts
import type { FastifyInstance } from 'fastify'
import { sql } from 'drizzle-orm'

export default async function healthRoutes(app: FastifyInstance) {
  // Readiness, not liveness: it checks the dependency the process cannot work
  // without, so k8s stops routing traffic here when Postgres is unreachable.
  app.get('/api/health', async (_req, reply) => {
    try {
      await app.db.execute(sql`SELECT 1`)
      return { status: 'ok', database: 'ok' }
    } catch {
      return reply.status(503).send({ status: 'degraded', database: 'unreachable' })
    }
  })
}
```

`apps/api/src/app.ts`:
```ts
import Fastify from 'fastify'
import { randomUUID } from 'node:crypto'
import type { Database } from '@marketplace/db'
import type { ApiConfig } from './config.js'
import dbPlugin from './plugins/db.js'
import errorHandler from './plugins/error-handler.js'
import creatorContext from './plugins/creator-context.js'
import healthRoutes from './routes/health.js'
import devRoutes from './routes/dev.js'
// NOTE: campaignRoutes / bidRoutes / creatorRoutes are added in Task 9. Task 8
// deliberately does not import them, so its own suite is green on its own —
// a task that cannot be tested until a later task lands is not a task boundary.

export function buildApp({ db, config }: { db: Database; config: ApiConfig }) {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL, base: { service: 'api' } },
    // Honour an inbound correlation id so a browser request, this span and a
    // downstream call share one identifier; generate one otherwise.
    genReqId: (req) => (req.headers['x-request-id'] as string) ?? randomUUID(),
  })

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id)
  })

  app.register(dbPlugin, { db })
  app.register(errorHandler)
  app.register(creatorContext)
  app.register(healthRoutes)
  app.register(devRoutes, { enabled: config.ENABLE_DEV_TOOLS })

  return app
}
```

`apps/api/src/server.ts`:
```ts
import { createDb } from '@marketplace/db'
import { buildApp } from './app.js'
import { loadConfig } from './config.js'

const config = loadConfig()
const { db, close } = createDb(config.DATABASE_URL, { max: 10 })
const app = buildApp({ db, config })

const shutdown = async () => {
  app.log.info('shutting down')
  await app.close()
  await close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

await app.listen({ port: config.PORT, host: '0.0.0.0' })
```

- [ ] **Step 5: Write the app-level test**

`apps/api/src/app.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { buildApp } from './app.js'
import type { Database } from '@marketplace/db'

// A stub is enough here: these tests are about the middleware contract, not SQL.
const stubDb = { execute: async () => [], select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) } as unknown as Database
const config = { DATABASE_URL: 'x', PORT: 0, LOG_LEVEL: 'silent' as const, ENABLE_DEV_TOOLS: false }

describe('app middleware', () => {
  it('serves health without a creator header', async () => {
    const app = buildApp({ db: stubDb, config })
    const res = await app.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(200)
    await app.close()
  })

  it('echoes an inbound x-request-id', async () => {
    const app = buildApp({ db: stubDb, config })
    const res = await app.inject({
      method: 'GET', url: '/api/health', headers: { 'x-request-id': 'trace-abc' },
    })
    expect(res.headers['x-request-id']).toBe('trace-abc')
    await app.close()
  })

  it('rejects an identity-requiring route with no header', async () => {
    const app = buildApp({ db: stubDb, config })
    const res = await app.inject({ method: 'GET', url: '/api/campaigns' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('CREATOR_REQUIRED')
    await app.close()
  })

  it('404s the dev route when dev tools are disabled', async () => {
    const app = buildApp({ db: stubDb, config })
    const res = await app.inject({
      method: 'POST', url: '/api/dev/campaigns/00000000-0000-4000-8000-000000000000/expire',
      headers: { 'x-creator-id': 'x' },
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })
})
```

- [ ] **Step 6: Run, then commit**

Run: `pnpm test -- app`
Expected: 7 PASS, with no dependency on Task 9.

The identity tests register their own `/probe` route inside the test rather than borrowing `/api/campaigns`: the contract under test belongs to the plugin, not to whichever product route happens to exist yet.

Two defects this suite caught:
- Fastify runs root-level `preHandler` hooks for the **not-found** handler, where `request.routeOptions.url` is `undefined`. The original guard (`ANONYMOUS.has(url ?? '')`) therefore demanded a creator header on every unknown path, so a typo'd URL answered `400 CREATOR_REQUIRED` instead of `404`, and a disabled dev route was indistinguishable from an unauthenticated one. Fixed by returning early when no route matched.
- `routes/dev.ts` moved into this task. It is the flag whose default must fail safe, so it gets its test here rather than two tasks later — and both directions are asserted: disabled ⇒ the route is absent from the router (404), enabled ⇒ it exists and goes through the same identity pipeline (400 without a header).

```bash
git add -A
git commit -m "feat(api): app skeleton with single-source identity, stable error codes and request correlation"
```

---

### Task 9: API routes — matched campaigns, bids, dev tools

**Files:**
- Create: `apps/api/src/repositories/{campaigns,bids}.ts`
- Create: `apps/api/src/services/{matching,bidding}.ts`
- Create: `apps/api/src/routes/{creators,campaigns,bids,dev}.ts`
- Test: `apps/api/src/services/bidding.integration.test.ts`

Test factories live in `packages/db/src/test-support/factories.ts`, exported as `@marketplace/db/test-support`. The db package owns the schema, so factories for that schema belong there; the alternative had `apps/api` importing `apps/worker`'s test folder, coupling two independently deployable services through their tests.

**Interfaces:**
- Consumes: `checkEligibility`, `scoreFit`, `isEligible` from `@marketplace/domain`; `AppError` helpers.
- Produces:
  - `listMatchedCampaigns(db, creator): Promise<MatchedCampaignsResponse>`
  - `placeBid(db, { creator, campaignId, amountCents, pitch }): Promise<BidView>`
  - `repriceBid`, `withdrawBid`
  - `listMyBids(db, creator): Promise<BidView[]>`
  - Response types shared with the web app via `apps/api/src/routes/types.ts`

- [ ] **Step 1: Define the wire types**

`apps/api/src/routes/types.ts` — the web app imports these directly (type-only, so no runtime coupling), which means a response-shape change is a compile error in the frontend instead of a runtime surprise.

```ts
import type { FitScore, IneligibilityReason } from '@marketplace/domain'

export type CampaignSummary = {
  id: string
  brandName: string
  title: string
  brief: string
  targetGenre: string
  minFollowers: number
  minEngagementRate: number
  budgetCents: number
  biddingDeadline: string          // ISO
  /** Derived, never stored — see spec §4.1. */
  phase: 'biddable' | 'awaiting_results' | 'settled'
}

export type MatchedCampaign = CampaignSummary & {
  fit: FitScore
  /** The creator's own bid on this campaign, if any. */
  myBid: BidView | null
}

export type IneligibleCampaign = CampaignSummary & {
  reasons: IneligibilityReason[]
}

export type MatchedCampaignsResponse = {
  matched: MatchedCampaign[]       // ranked, fit desc
  ineligible: IneligibleCampaign[]
  creator: {
    id: string; handle: string; displayName: string; genre: string
    followerCount: number; engagementRate: number
    statsUpdatedAt: string         // provenance: these stats are not ours
  }
}

export type BidView = {
  id: string
  campaignId: string
  amountCents: number
  fitScoreAtBidTime: number
  pitch: string | null
  status: 'pending' | 'won' | 'lost' | 'withdrawn'
  createdAt: string
  decidedAt: string | null
  /** Populated for lost bids by the closer. */
  lossReason: 'below_quality_bar' | 'outranked' | 'did_not_fit_remaining_budget' | null
  campaign: CampaignSummary
}
```

- [ ] **Step 2: Implement the matching service**

`apps/api/src/services/matching.ts`:
```ts
import { asc, eq } from 'drizzle-orm'
import { campaigns, bids, type Creator, type Database } from '@marketplace/db'
import { checkEligibility, scoreFit } from '@marketplace/domain'
import type { MatchedCampaignsResponse, CampaignSummary } from '../routes/types.js'
import { campaignPhase, toCampaignSummary, toBidView } from '../repositories/campaigns.js'

/**
 * Ranks every campaign for one creator.
 *
 * Deliberately scored in application code rather than SQL: at this scale the
 * whole campaign set is a few dozen rows, and keeping the rule in the domain
 * package means it is unit-testable and shared. Spec §15 documents the
 * migration path to a set-based query, and the trigger for taking it.
 */
export async function listMatchedCampaigns(
  db: Database,
  creator: Creator,
): Promise<MatchedCampaignsResponse> {
  const profile = {
    genre: creator.genre,
    followerCount: creator.followerCount,
    engagementRate: Number(creator.engagementRate),
  }

  const [allCampaigns, myBids] = await Promise.all([
    db.select().from(campaigns).orderBy(asc(campaigns.biddingDeadline), asc(campaigns.id)),
    db.select().from(bids).where(eq(bids.creatorId, creator.id)),
  ])
  const bidByCampaign = new Map(myBids.map((b) => [b.campaignId, b]))

  const matched: MatchedCampaignsResponse['matched'] = []
  const ineligible: MatchedCampaignsResponse['ineligible'] = []

  for (const campaign of allCampaigns) {
    const requirements = {
      targetGenre: campaign.targetGenre,
      minFollowers: campaign.minFollowers,
      minEngagementRate: Number(campaign.minEngagementRate),
    }
    const summary = toCampaignSummary(campaign)
    const reasons = checkEligibility(profile, requirements)

    if (reasons.length > 0) {
      // Shown, not hidden — spec §5.5. A creator should learn what to grow toward.
      ineligible.push({ ...summary, reasons })
      continue
    }

    const bid = bidByCampaign.get(campaign.id)
    matched.push({
      ...summary,
      fit: scoreFit(profile, requirements),
      myBid: bid ? toBidView(bid, summary) : null,
    })
  }

  // Ties broken by id so the feed order is stable across refreshes — a list
  // that reshuffles on every poll feels broken.
  matched.sort((a, b) => b.fit.total - a.fit.total || (a.id < b.id ? -1 : 1))

  return {
    matched,
    ineligible,
    creator: {
      id: creator.id, handle: creator.handle, displayName: creator.displayName,
      genre: creator.genre, followerCount: creator.followerCount,
      engagementRate: Number(creator.engagementRate),
      statsUpdatedAt: creator.statsUpdatedAt.toISOString(),
    },
  }
}
```

`apps/api/src/repositories/campaigns.ts`:
```ts
import type { Bid, Campaign } from '@marketplace/db'
import type { BidView, CampaignSummary } from '../routes/types.js'

/**
 * Three presentation phases from two stored states. The middle one is not
 * cosmetic: it is the real window between a deadline and the worker's next
 * tick, and without it the app looks broken for ~15 seconds.
 */
export function campaignPhase(campaign: Campaign, now = new Date()): CampaignSummary['phase'] {
  if (campaign.status === 'closed') return 'settled'
  return campaign.biddingDeadline > now ? 'biddable' : 'awaiting_results'
}

export const toCampaignSummary = (c: Campaign, now = new Date()): CampaignSummary => ({
  id: c.id, brandName: c.brandName, title: c.title, brief: c.brief,
  targetGenre: c.targetGenre, minFollowers: c.minFollowers,
  minEngagementRate: Number(c.minEngagementRate), budgetCents: c.budgetCents,
  biddingDeadline: c.biddingDeadline.toISOString(), phase: campaignPhase(c, now),
})

export const toBidView = (
  b: Bid, campaign: CampaignSummary, lossReason: BidView['lossReason'] = null,
): BidView => ({
  id: b.id, campaignId: b.campaignId, amountCents: b.amountCents,
  fitScoreAtBidTime: Number(b.fitScore), pitch: b.pitch, status: b.status,
  createdAt: b.createdAt.toISOString(),
  decidedAt: b.decidedAt?.toISOString() ?? null,
  lossReason, campaign,
})
```

- [ ] **Step 3: Implement the bidding service, with `FOR SHARE`**

`apps/api/src/services/bidding.ts`:
```ts
import { and, eq } from 'drizzle-orm'
import { bids, bidEvents, campaigns, type Creator, type Database } from '@marketplace/db'
import { checkEligibility, scoreFit } from '@marketplace/domain'
import { conflict, forbidden, notFound, unprocessable } from '../errors.js'
import { toBidView, toCampaignSummary } from '../repositories/campaigns.js'
import type { BidView } from '../routes/types.js'

export async function placeBid(
  db: Database,
  input: { creator: Creator; campaignId: string; amountCents: number; pitch: string | null },
): Promise<BidView> {
  return db.transaction(async (tx) => {
    // FOR SHARE, not a plain read. This is the fix for the bid/close race
    // (spec §7.3): many bids may proceed concurrently with each other, but this
    // lock BLOCKS the closer's FOR UPDATE, so a bid can never land in the window
    // after the closer read this campaign's bids and before it committed.
    // Without it, a bid placed a millisecond before the deadline stays `pending`
    // forever on a closed auction.
    const [campaign] = await tx.select().from(campaigns)
      .where(eq(campaigns.id, input.campaignId)).limit(1).for('share')

    if (!campaign) throw notFound('CAMPAIGN_NOT_FOUND', 'Campaign not found')

    if (campaign.status !== 'open' || campaign.biddingDeadline <= new Date()) {
      throw conflict('CAMPAIGN_NOT_BIDDABLE', 'Bidding has closed for this campaign')
    }

    const profile = {
      genre: input.creator.genre,
      followerCount: input.creator.followerCount,
      engagementRate: Number(input.creator.engagementRate),
    }
    const requirements = {
      targetGenre: campaign.targetGenre,
      minFollowers: campaign.minFollowers,
      minEngagementRate: Number(campaign.minEngagementRate),
    }

    const reasons = checkEligibility(profile, requirements)
    if (reasons.length > 0) {
      throw unprocessable('CREATOR_INELIGIBLE', 'You do not meet this campaign’s requirements', reasons)
    }

    // A bid above the whole budget can never win, so accepting it would be a
    // lie dressed up as a feature.
    if (input.amountCents > campaign.budgetCents) {
      throw unprocessable('BID_EXCEEDS_BUDGET', 'Your bid is larger than the campaign budget')
    }

    const fit = scoreFit(profile, requirements)
    const now = new Date()

    // Upsert on (campaign_id, creator_id): also the reinstate path for a
    // previously withdrawn bid. fit_score is re-snapshotted, because the bid
    // is a new offer and should be judged on today's numbers.
    const [existing] = await tx.select().from(bids)
      .where(and(eq(bids.campaignId, campaign.id), eq(bids.creatorId, input.creator.id)))
      .limit(1)

    if (existing && (existing.status === 'won' || existing.status === 'lost')) {
      throw conflict('BID_NOT_EDITABLE', 'This bid has already been decided')
    }

    const [bid] = await tx.insert(bids).values({
      campaignId: campaign.id, creatorId: input.creator.id,
      amountCents: input.amountCents, fitScore: fit.total.toFixed(2),
      pitch: input.pitch, status: 'pending', updatedAt: now,
    }).onConflictDoUpdate({
      target: [bids.campaignId, bids.creatorId],
      set: { amountCents: input.amountCents, fitScore: fit.total.toFixed(2),
             pitch: input.pitch, status: 'pending', updatedAt: now },
    }).returning()

    // Same transaction as the mutation. An audit log that can survive a
    // rolled-back transaction is a log that lies.
    await tx.insert(bidEvents).values({
      bidId: bid!.id,
      type: !existing ? 'placed' : existing.status === 'withdrawn' ? 'reinstated' : 'repriced',
      amountCents: input.amountCents, fitScore: fit.total.toFixed(2),
      actor: 'creator', metadata: {},
    })

    return toBidView(bid!, toCampaignSummary(campaign))
  })
}

export async function withdrawBid(
  db: Database, { creator, bidId }: { creator: Creator; bidId: string },
): Promise<BidView> {
  return db.transaction(async (tx) => {
    const [bid] = await tx.select().from(bids).where(eq(bids.id, bidId)).limit(1).for('update')
    if (!bid) throw notFound('BID_NOT_FOUND', 'Bid not found')
    if (bid.creatorId !== creator.id) {
      // Not security (there is no auth), but the ownership check belongs here
      // so that adding auth later does not require finding every mutation.
      throw forbidden('NOT_BID_OWNER', 'Not your bid')
    }
    if (bid.status !== 'pending') throw conflict('BID_NOT_EDITABLE', 'This bid can no longer be changed')

    const now = new Date()
    const [updated] = await tx.update(bids)
      .set({ status: 'withdrawn', updatedAt: now }).where(eq(bids.id, bidId)).returning()

    await tx.insert(bidEvents).values({
      bidId, type: 'withdrawn', amountCents: bid.amountCents,
      fitScore: bid.fitScore, actor: 'creator', metadata: {},
    })

    const [campaign] = await tx.select().from(campaigns).where(eq(campaigns.id, bid.campaignId)).limit(1)
    return toBidView(updated!, toCampaignSummary(campaign!))
  })
}
```

- [ ] **Step 4: Implement `listMyBids` with loss reasons**

Add to `apps/api/src/services/bidding.ts`:
```ts
import { desc, inArray, sql } from 'drizzle-orm'

/**
 * A creator's bids, newest first, each carrying the loss reason the closer
 * recorded. The reason lives in bid_events rather than on the bid row because
 * it is a fact about a decision, not current state — and joining it here keeps
 * the read model simple without denormalising.
 */
export async function listMyBids(db: Database, creator: Creator): Promise<BidView[]> {
  const rows = await db.select({ bid: bids, campaign: campaigns })
    .from(bids)
    .innerJoin(campaigns, eq(campaigns.id, bids.campaignId))
    .where(eq(bids.creatorId, creator.id))
    .orderBy(desc(bids.createdAt), desc(bids.id))

  if (rows.length === 0) return []

  const lostIds = rows.filter((r) => r.bid.status === 'lost').map((r) => r.bid.id)
  const reasons = new Map<string, BidView['lossReason']>()
  if (lostIds.length > 0) {
    const events = await db.select().from(bidEvents)
      .where(and(inArray(bidEvents.bidId, lostIds), eq(bidEvents.type, 'lost')))
    for (const e of events) {
      const reason = (e.metadata as { reason?: string }).reason
      if (reason) reasons.set(e.bidId, reason as BidView['lossReason'])
    }
  }

  return rows.map((r) =>
    toBidView(r.bid, toCampaignSummary(r.campaign), reasons.get(r.bid.id) ?? null))
}
```

- [ ] **Step 5: Wire the routes**

`apps/api/src/routes/campaigns.ts`:
```ts
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { listMatchedCampaigns } from '../services/matching.js'
import { placeBid } from '../services/bidding.js'

const placeBidBody = z.object({
  amountCents: z.number().int().positive().max(100_000_000),
  pitch: z.string().max(500).nullable().default(null),
})

export default async function campaignRoutes(app: FastifyInstance) {
  app.get('/api/campaigns', async (request) =>
    listMatchedCampaigns(app.db, request.creator))

  app.post('/api/campaigns/:id/bids', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const body = placeBidBody.parse(request.body)
    const bid = await placeBid(app.db, {
      creator: request.creator, campaignId: id,
      amountCents: body.amountCents, pitch: body.pitch,
    })
    return reply.status(201).send(bid)
  })
}
```

`apps/api/src/routes/bids.ts`:
```ts
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { listMyBids, withdrawBid } from '../services/bidding.js'

export default async function bidRoutes(app: FastifyInstance) {
  app.get('/api/bids', async (request) => listMyBids(app.db, request.creator))

  app.post('/api/bids/:id/withdraw', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    return withdrawBid(app.db, { creator: request.creator, bidId: id })
  })
}
```

`apps/api/src/routes/creators.ts`:
```ts
import type { FastifyInstance } from 'fastify'
import { asc } from 'drizzle-orm'
import { creators } from '@marketplace/db'

export default async function creatorRoutes(app: FastifyInstance) {
  // The only identity-free route: it is the creator picker.
  app.get('/api/creators', async () => {
    const rows = await app.db.select().from(creators).orderBy(asc(creators.handle))
    return rows.map((c) => ({
      id: c.id, handle: c.handle, displayName: c.displayName, genre: c.genre,
      followerCount: c.followerCount, engagementRate: Number(c.engagementRate),
      statsUpdatedAt: c.statsUpdatedAt.toISOString(),
    }))
  })
}
```

`apps/api/src/routes/dev.ts`:
```ts
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { campaigns } from '@marketplace/db'
import { conflict, notFound } from '../errors.js'

/**
 * Demo affordance so a reviewer does not have to wait out a real deadline.
 *
 * It moves a DEADLINE. It cannot close an auction, select winners, or touch a
 * bid — the worker remains the only thing that closes anything, so the loop
 * being demonstrated is the real one.
 */
export default async function devRoutes(app: FastifyInstance, opts: { enabled: boolean }) {
  if (!opts.enabled) return

  app.post('/api/dev/campaigns/:id/expire', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const [updated] = await app.db.update(campaigns)
      .set({ biddingDeadline: new Date() })
      .where(and(eq(campaigns.id, id), eq(campaigns.status, 'open')))
      .returning()

    if (!updated) throw notFound('CAMPAIGN_NOT_FOUND', 'No open campaign with that id')
    request.log.warn({ campaignId: id }, 'dev tool expired a campaign deadline')
    return { id: updated.id, biddingDeadline: updated.biddingDeadline.toISOString() }
  })
}
```

Register `creatorRoutes` in `app.ts` alongside the others.

- [ ] **Step 6: Write the bidding integration test**

`apps/api/src/services/bidding.integration.test.ts` — cover: a successful bid snapshots fit and writes a `placed` event; an ineligible creator gets `CREATOR_INELIGIBLE`; a bid above budget gets `BID_EXCEEDS_BUDGET`; a bid on a past-deadline campaign gets `CAMPAIGN_NOT_BIDDABLE`; a second bid by the same creator repricing updates in place and writes `repriced`; withdrawing then re-bidding writes `reinstated`; withdrawing someone else's bid gets `NOT_BID_OWNER`; a decided bid cannot be repriced.

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { bidEvents, bids } from '@marketplace/db'
import { placeBid, withdrawBid } from './bidding.js'
import { connect, truncateAll, makeCreator, makeCampaign } from '@marketplace/db/test-support'

let ctx: ReturnType<typeof connect>
beforeAll(() => { ctx = connect() })
afterAll(async () => { await ctx.close() })
beforeEach(async () => { await truncateAll(ctx.db) })

describe('placeBid', () => {
  it('snapshots the fit score and records a placed event', async () => {
    const creator = await makeCreator(ctx.db, { genre: 'fitness', followerCount: 120_000, engagementRate: '0.0600' })
    const campaign = await makeCampaign(ctx.db, { biddingDeadline: new Date(Date.now() + 600_000) })

    const bid = await placeBid(ctx.db, {
      creator, campaignId: campaign.id, amountCents: 120_000, pitch: 'hello',
    })

    expect(bid.status).toBe('pending')
    expect(bid.fitScoreAtBidTime).toBeGreaterThan(0)
    const [row] = await ctx.db.select().from(bids).where(eq(bids.id, bid.id))
    // The stored snapshot must equal what the API returned, or the UI and the
    // auction disagree about the same bid.
    expect(Number(row!.fitScore)).toBe(bid.fitScoreAtBidTime)
    const events = await ctx.db.select().from(bidEvents).where(eq(bidEvents.bidId, bid.id))
    expect(events.map((e) => e.type)).toEqual(['placed'])
    expect(events[0]!.actor).toBe('creator')
  })

  it('refuses a bid larger than the campaign budget', async () => {
    const creator = await makeCreator(ctx.db)
    const campaign = await makeCampaign(ctx.db, {
      budgetCents: 100_000, biddingDeadline: new Date(Date.now() + 600_000),
    })
    await expect(placeBid(ctx.db, {
      creator, campaignId: campaign.id, amountCents: 100_001, pitch: null,
    })).rejects.toMatchObject({ code: 'BID_EXCEEDS_BUDGET' })
  })

  it('refuses a bid after the deadline', async () => {
    const creator = await makeCreator(ctx.db)
    const campaign = await makeCampaign(ctx.db, { biddingDeadline: new Date(Date.now() - 1_000) })
    await expect(placeBid(ctx.db, {
      creator, campaignId: campaign.id, amountCents: 50_000, pitch: null,
    })).rejects.toMatchObject({ code: 'CAMPAIGN_NOT_BIDDABLE' })
  })

  it('refuses an ineligible creator, reporting the gates they failed', async () => {
    const creator = await makeCreator(ctx.db, { followerCount: 500 })
    const campaign = await makeCampaign(ctx.db, { biddingDeadline: new Date(Date.now() + 600_000) })
    await expect(placeBid(ctx.db, {
      creator, campaignId: campaign.id, amountCents: 50_000, pitch: null,
    })).rejects.toMatchObject({ code: 'CREATOR_INELIGIBLE' })
  })

  it('reprices in place rather than creating a second bid', async () => {
    const creator = await makeCreator(ctx.db)
    const campaign = await makeCampaign(ctx.db, { biddingDeadline: new Date(Date.now() + 600_000) })
    const first = await placeBid(ctx.db, { creator, campaignId: campaign.id, amountCents: 100_000, pitch: null })
    const second = await placeBid(ctx.db, { creator, campaignId: campaign.id, amountCents: 80_000, pitch: 'cheaper' })

    expect(second.id).toBe(first.id)
    expect(second.amountCents).toBe(80_000)
    const all = await ctx.db.select().from(bids)
    expect(all).toHaveLength(1)
    const events = await ctx.db.select().from(bidEvents).where(eq(bidEvents.bidId, first.id))
    expect(events.map((e) => e.type)).toEqual(['placed', 'repriced'])
  })

  it('records a reinstated event when re-bidding after withdrawal', async () => {
    const creator = await makeCreator(ctx.db)
    const campaign = await makeCampaign(ctx.db, { biddingDeadline: new Date(Date.now() + 600_000) })
    const bid = await placeBid(ctx.db, { creator, campaignId: campaign.id, amountCents: 100_000, pitch: null })
    await withdrawBid(ctx.db, { creator, bidId: bid.id })
    await placeBid(ctx.db, { creator, campaignId: campaign.id, amountCents: 95_000, pitch: null })

    const events = await ctx.db.select().from(bidEvents).where(eq(bidEvents.bidId, bid.id))
    expect(events.map((e) => e.type)).toEqual(['placed', 'withdrawn', 'reinstated'])
  })

  it('refuses to withdraw another creator’s bid', async () => {
    const owner = await makeCreator(ctx.db)
    const other = await makeCreator(ctx.db)
    const campaign = await makeCampaign(ctx.db, { biddingDeadline: new Date(Date.now() + 600_000) })
    const bid = await placeBid(ctx.db, { creator: owner, campaignId: campaign.id, amountCents: 100_000, pitch: null })
    await expect(withdrawBid(ctx.db, { creator: other, bidId: bid.id }))
      .rejects.toMatchObject({ code: 'NOT_BID_OWNER' })
  })
})
```

- [ ] **Step 7: Run everything and commit**

Run: `pnpm test && pnpm test:integration`
Expected: all PASS.

```bash
git add -A
git commit -m "feat(api): matched campaigns, bidding with FOR SHARE against the close race, and gated dev tools"
```

---

### Task 10: Web app — scaffold, API client, creator picker

**Files:**
- Create: `apps/web/{package.json,vite.config.ts,tsconfig.json,index.html,tailwind.config.ts,postcss.config.js,nginx.conf}`
- Create: `apps/web/src/{main.tsx,App.tsx,index.css}`
- Create: `apps/web/src/api/client.ts`
- Create: `apps/web/src/state/CreatorProvider.tsx`
- Create: `apps/web/src/pages/CreatorPicker.tsx`
- Create: `apps/web/src/components/{Money.tsx,GenrePill.tsx,StatsFreshness.tsx}`

**Interfaces:**
- Consumes: type-only imports from `apps/api/src/routes/types.ts`.
- Produces: `useCreator()`, `api` client, routes `/`, `/campaigns`, `/bids`.

- [ ] **Step 1: Scaffold Vite**

Run:
```bash
cd apps/web
pnpm create vite@latest . --template react-ts
pnpm add react-router-dom @tanstack/react-query
pnpm add -D tailwindcss @tailwindcss/vite
```

`apps/web/vite.config.ts`:
```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Same-origin in dev, matching what nginx does in compose. No CORS, ever —
    // not in dev, not in prod, so there is no CORS config to get wrong.
    proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: true } },
  },
  build: { outDir: 'dist', sourcemap: true },
})
```

`apps/web/nginx.conf`:
```nginx
server {
  listen 80;
  root /usr/share/nginx/html;

  # Hashed asset filenames, so they are immutable.
  location /assets/ {
    expires 1y;
    add_header Cache-Control "public, immutable";
  }

  # Stands in for the ingress or CDN that would sit here in production.
  location /api/ {
    proxy_pass http://api:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Request-Id $request_id;
  }

  # SPA fallback: any unknown path is a client route, not a 404.
  location / {
    try_files $uri $uri/ /index.html;
  }
}
```

- [ ] **Step 2: Write the API client**

`apps/web/src/api/client.ts`:
```ts
import type {
  BidView, MatchedCampaignsResponse,
} from '../../../api/src/routes/types.js'

export type CreatorListItem = MatchedCampaignsResponse['creator']

export type ApiErrorCode =
  | 'CREATOR_REQUIRED' | 'CREATOR_NOT_FOUND' | 'CAMPAIGN_NOT_FOUND'
  | 'CAMPAIGN_NOT_BIDDABLE' | 'CREATOR_INELIGIBLE' | 'BID_EXCEEDS_BUDGET'
  | 'BID_NOT_FOUND' | 'NOT_BID_OWNER' | 'BID_NOT_EDITABLE'
  | 'VALIDATION_FAILED' | 'INTERNAL'

/** Thrown for every non-2xx, carrying the server's stable code. */
export class ApiError extends Error {
  constructor(readonly code: ApiErrorCode, message: string, readonly details?: unknown) {
    super(message)
  }
}

/**
 * Maps error codes to copy in one place. Components render
 * `messageFor(err)` and never branch on status codes or parse messages, so
 * adding a server error code is a compile error here rather than a blank
 * toast in production.
 */
export const ERROR_COPY: Record<ApiErrorCode, string> = {
  CREATOR_REQUIRED: 'Pick a creator first.',
  CREATOR_NOT_FOUND: 'That creator no longer exists. Pick another.',
  CAMPAIGN_NOT_FOUND: 'This campaign is no longer available.',
  CAMPAIGN_NOT_BIDDABLE: 'Bidding has closed for this campaign.',
  CREATOR_INELIGIBLE: 'You don’t meet this campaign’s requirements.',
  BID_EXCEEDS_BUDGET: 'Your bid is larger than the whole campaign budget.',
  BID_NOT_FOUND: 'We couldn’t find that bid.',
  NOT_BID_OWNER: 'That bid belongs to another creator.',
  BID_NOT_EDITABLE: 'This bid has already been decided and can’t be changed.',
  VALIDATION_FAILED: 'Please check the amount you entered.',
  INTERNAL: 'Something went wrong on our side. Try again in a moment.',
}

export const messageFor = (e: unknown): string =>
  e instanceof ApiError ? ERROR_COPY[e.code] ?? e.message : 'Something went wrong.'

let currentCreatorId: string | null = null
export const setCreatorId = (id: string | null) => { currentCreatorId = id }

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(currentCreatorId ? { 'x-creator-id': currentCreatorId } : {}),
      ...init.headers,
    },
  })

  if (!res.ok) {
    const body = await res.json().catch(() => null)
    const err = body?.error
    throw new ApiError(err?.code ?? 'INTERNAL', err?.message ?? res.statusText, err?.details)
  }
  return res.status === 204 ? (undefined as T) : res.json()
}

export const api = {
  listCreators: () => request<CreatorListItem[]>('/api/creators'),
  matchedCampaigns: () => request<MatchedCampaignsResponse>('/api/campaigns'),
  myBids: () => request<BidView[]>('/api/bids'),
  placeBid: (campaignId: string, amountCents: number, pitch: string | null) =>
    request<BidView>(`/api/campaigns/${campaignId}/bids`, {
      method: 'POST', body: JSON.stringify({ amountCents, pitch }),
    }),
  withdrawBid: (bidId: string) =>
    request<BidView>(`/api/bids/${bidId}/withdraw`, { method: 'POST' }),
  expireCampaign: (campaignId: string) =>
    request<{ id: string }>(`/api/dev/campaigns/${campaignId}/expire`, { method: 'POST' }),
}
```

- [ ] **Step 3: Write the creator provider**

`apps/web/src/state/CreatorProvider.tsx` — holds the selected creator in `localStorage` (so a refresh doesn't drop you back to the picker), and calls `setCreatorId` so the client sends the header.

```tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { setCreatorId } from '../api/client'

const KEY = 'marketplace.creatorId'
const Ctx = createContext<{
  creatorId: string | null
  select: (id: string | null) => void
}>({ creatorId: null, select: () => {} })

export function CreatorProvider({ children }: { children: ReactNode }) {
  const [creatorId, setId] = useState<string | null>(() => localStorage.getItem(KEY))

  // Keep the module-level header in sync before any query runs.
  useEffect(() => { setCreatorId(creatorId) }, [creatorId])

  const select = (id: string | null) => {
    if (id) localStorage.setItem(KEY, id)
    else localStorage.removeItem(KEY)
    setCreatorId(id)
    setId(id)
  }

  return <Ctx.Provider value={{ creatorId, select }}>{children}</Ctx.Provider>
}

export const useCreator = () => useContext(Ctx)
```

- [ ] **Step 4: Wire the app shell and routes**

`apps/web/src/App.tsx` — `BrowserRouter` with `/` (picker), `/campaigns`, `/bids`; a header showing the active creator with a "switch" action; redirect to `/` when no creator is selected. `QueryClient` configured with `staleTime: 2_000` and `refetchInterval: 5_000` on the campaign and bid queries — polling is how the UI learns the worker ran, and 5s against a 15s worker interval means at most ~20s from deadline to visible result.

- [ ] **Step 5: Build the creator picker**

`apps/web/src/pages/CreatorPicker.tsx` — a responsive grid of creator cards: handle, display name, genre pill, follower count (formatted `412k`), engagement rate as a percentage, and `StatsFreshness` showing "stats updated 2h ago". Clicking selects and navigates to `/campaigns`.

`StatsFreshness` renders amber when `statsUpdatedAt` is older than 24h — honest about the fact that these numbers come from an ingestion pipeline we don't own, and the seed deliberately includes one creator at 30h so that state is visible.

- [ ] **Step 6: Verify and commit**

Run: `pnpm --filter @marketplace/web dev`, open the printed URL, confirm the picker lists 8 creators and selecting one navigates.

```bash
git add -A
git commit -m "feat(web): app shell, single-source creator identity, error-code copy map, creator picker"
```

---

### Task 11: Web — campaign feed, score breakdown, bid drawer

**Files:**
- Create: `apps/web/src/pages/CampaignFeed.tsx`
- Create: `apps/web/src/components/{FitScoreBadge,ScoreBreakdown,CampaignCard,IneligibleSection,DeadlineCountdown,BidDrawer}.tsx`

- [ ] **Step 1: Build `FitScoreBadge` and `ScoreBreakdown`**

The badge shows the total as a large number with a colour band (≥80 strong, 60–79 good, 40–59 fair, <40 weak) **and the `MIN_FIT_TO_WIN` threshold marked**, because a creator's first question is "can I win this at all?"

`ScoreBreakdown` renders one row per component: label, a proportional bar of `score`, the weight as a percentage, and the `detail` string. This is the component that answers the brief's *"is the match score presented in a way that helps them decide what to bid on?"* — a bare `87%` is not actionable; "Genre match: exact (50% of score)" is.

```tsx
export function ScoreBreakdown({ fit }: { fit: FitScore }) {
  return (
    <dl className="space-y-2">
      {fit.components.map((c) => (
        <div key={c.key} className="grid grid-cols-[7rem_1fr_auto] items-center gap-2 text-sm">
          <dt className="text-slate-600">{c.label}</dt>
          <dd className="h-2 rounded bg-slate-200" aria-label={`${c.label}: ${Math.round(c.score * 100)}%`}>
            <div className="h-2 rounded bg-slate-900" style={{ width: `${c.score * 100}%` }} />
          </dd>
          <dd className="tabular-nums text-slate-500">{Math.round(c.weight * 100)}%</dd>
          <dd className="col-span-3 text-xs text-slate-500">{c.detail}</dd>
        </div>
      ))}
    </dl>
  )
}
```

- [ ] **Step 2: Build `CampaignCard` and `DeadlineCountdown`**

Card shows brand, title, budget (`formatEur`), fit badge, deadline countdown, and a primary action that depends on `phase` and `myBid`:

| phase | myBid | Action / state |
|---|---|---|
| `biddable` | none | **Place bid** |
| `biddable` | pending | **Edit bid** · Withdraw · shows current amount |
| `biddable` | withdrawn | **Bid again** |
| `awaiting_results` | any | Disabled, "Bidding closed — results pending" with a spinner |
| `settled` | won | Green "You won · €X" |
| `settled` | lost | Grey "Not selected" + the loss reason |
| `settled` | none | Muted "Closed" |

`DeadlineCountdown` ticks every second under an hour and shows "in 3 days" beyond that. Under five minutes it turns amber — the signal that this is the one worth bidding on now.

- [ ] **Step 3: Build `IneligibleSection`**

Collapsed by default with a count in the summary (`<details>`, so it is keyboard-accessible for free). Each row renders the campaign plus its specific gap, built from the `IneligibilityReason` union:

```tsx
const reasonCopy = (r: IneligibilityReason): string =>
  r.code === 'BELOW_MIN_FOLLOWERS'
    ? `Needs ${compact(r.required)} followers — you have ${compact(r.actual)}`
    : `Needs ${(r.required * 100).toFixed(1)}% engagement — yours is ${(r.actual * 100).toFixed(1)}%`
```

This is why `IneligibilityReason` is a discriminated union carrying numbers rather than a string: the UI can be specific, and adding a gate is a compile error here until copy exists for it.

- [ ] **Step 4: Build `BidDrawer`**

Fields: amount in euros (`parseEuroInput` on change, so "1.200,50" works), optional pitch (500 chars, counter). Live guidance derived from the **actual selection rule**, not invented:

- `formatEur(budgetCents)` as the ceiling, with an inline error when the amount exceeds it — the same rule the API enforces, checked client-side so the user doesn't need a round-trip to learn it.
- "Your bid is 16% of this campaign's budget" — the single most decision-relevant number, since more budget headroom means more room for the greedy fill to reach you.
- A note when `fit.total < MIN_FIT_TO_WIN`: "Your fit score is below this campaign's quality bar, so this bid can't win." Honest, and it prevents a wasted bid.

It deliberately does **not** show other creators' bids or a predicted rank. Leaking competitors' prices would change bidding behaviour, and a predicted rank would be a promise the auction can't keep.

Submit uses a TanStack mutation that invalidates both `['campaigns']` and `['bids']`, with the pending state on the button and `messageFor(error)` inline.

- [ ] **Step 5: Verify and commit**

Manually: select `@liftwithlena`, confirm Gymshark (exact genre, 7.8% engagement) ranks above Zalando (unrelated genre), confirm Oatly appears under "Not eligible yet" with "Needs 500k followers — you have 128k", place a bid, confirm it appears on the card.

```bash
git add -A
git commit -m "feat(web): ranked campaign feed with score breakdown, eligibility reasons and bid drawer"
```

---

### Task 12: Web — my bids, polling, and the demo control

**Files:**
- Create: `apps/web/src/pages/MyBids.tsx`
- Create: `apps/web/src/components/{BidStatusPill,LossReason,ExpireCampaignButton}.tsx`

- [ ] **Step 1: Build `MyBids`**

Grouped into **Active** (pending on a biddable campaign), **Awaiting results** (pending, deadline passed), and **Decided** (won/lost/withdrawn). Each row: campaign, brand, amount, fit at bid time, status pill, and for decided bids the timestamp.

The grouping matters more than a flat list: a creator's real question is "what still needs my attention?" and "what am I waiting on?", which a status column alone doesn't answer.

- [ ] **Step 2: Build `LossReason`**

```tsx
const LOSS_COPY: Record<NonNullable<BidView['lossReason']>, string> = {
  below_quality_bar:
    'Your match score was below this campaign’s quality bar.',
  outranked:
    'The budget was fully committed to bids offering better value per euro.',
  did_not_fit_remaining_budget:
    'Budget remained, but not enough to cover your bid.',
}
```

Three distinct, actionable messages instead of "Not selected" — and each one maps to a real branch in `selectWinners`, so the copy cannot drift from the rule.

- [ ] **Step 2: Add the demo control**

`ExpireCampaignButton` renders only when `import.meta.env.VITE_ENABLE_DEV_TOOLS === 'true'`, styled as an obvious dev affordance (dashed amber border, "Demo" label). Copy: **"Expire deadline now (demo)"** — deliberately not "Close auction", because it doesn't close anything. Tooltip: *"Sets the deadline to now. The scheduled worker closes the auction on its next pass (~15s)."*

After it succeeds, invalidate `['campaigns']` and show a toast: "Deadline set. The worker closes this auction within ~15 seconds." Then polling surfaces the result with no further action — which is the whole loop, observed end to end.

- [ ] **Step 3: Verify the full loop, then commit**

1. `docker compose up` (Task 13) or `pnpm bootstrap && pnpm --filter @marketplace/api dev` + `--filter @marketplace/worker start:loop` + `--filter @marketplace/web dev`
2. Pick `@kitchen.kai`, open the feed, bid €2,500 on *HelloFresh*
3. Confirm the bid shows as Active under My bids
4. Click **Expire deadline now (demo)** on the HelloFresh card
5. Watch it move to Awaiting results, then within ~20s to won or lost with a reason — no refresh, no database access

```bash
git add -A
git commit -m "feat(web): grouped bid list with explained losses and a dev-gated deadline control"
```

---

### Task 13: Docker Compose, images, and CI

**Files:**
- Create: `docker-compose.yml`, `.dockerignore`
- Create: `apps/api/Dockerfile`, `apps/worker/Dockerfile`, `apps/web/Dockerfile`
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write the Dockerfiles**

All three are multi-stage with a `deps` stage that copies only the lockfile and the package manifests, so editing a source file does not invalidate the install layer. The runtime stage then copies the install tree wholesale (`COPY --from=deps /repo ./`) and overlays source on top.

Copying the install tree wholesale rather than enumerating `packages/*/node_modules` is not a style choice: `packages/domain` has no dependencies, so pnpm creates no `node_modules` directory for it and a per-package `COPY` fails with *"/repo/packages/domain/node_modules": not found*. `.dockerignore` excludes `node_modules` from the build context, so the source overlay cannot clobber the installed tree.

`apps/api` and `apps/worker` run TypeScript directly through `tsx` rather than compiling. The trade is explicit: slightly slower boot and a dev dependency in the image, in exchange for one fewer build stage that could diverge from what the tests ran against. The worker image is also the bootstrap image — compose overrides its `CMD` — so the migration path and the runtime path cannot drift apart.

`apps/web/Dockerfile` builds with Node then copies `dist/` into `nginx:alpine` alongside `nginx.conf` — the final web image contains no Node runtime at all, which is the deployment story from spec §2.2 made literal. It also copies `apps/api`, because the web app imports the route types type-only: a response-shape change is a frontend compile error rather than a runtime surprise.

- [ ] **Step 2: Write `docker-compose.yml`**

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: marketplace
      POSTGRES_PASSWORD: marketplace
      POSTGRES_DB: marketplace
    ports: ['5432:5432']
    volumes: ['pgdata:/var/lib/postgresql/data']
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U marketplace -d marketplace']
      interval: 2s
      timeout: 3s
      retries: 20

  # Migrate, seed, then settle already-expired seed campaigns via the real
  # closer. Runs to completion and exits; api and worker wait for it.
  # This is the same ordering a pre-deploy Job gives you in Kubernetes, and
  # the reason migrations are NOT run on API boot: N replicas booting would
  # race on the migration lock.
  bootstrap:
    build: { context: ., dockerfile: apps/worker/Dockerfile }
    command: sh -c "pnpm db:migrate && pnpm db:seed && pnpm --filter @marketplace/worker start:once"
    environment:
      DATABASE_URL: postgres://marketplace:marketplace@postgres:5432/marketplace
    depends_on:
      postgres: { condition: service_healthy }

  api:
    build: { context: ., dockerfile: apps/api/Dockerfile }
    environment:
      DATABASE_URL: postgres://marketplace:marketplace@postgres:5432/marketplace
      PORT: 3000
      # Explicitly on, only here. The default is false everywhere else.
      ENABLE_DEV_TOOLS: 'true'
    depends_on:
      bootstrap: { condition: service_completed_successfully }
    # The API takes a few seconds to boot. Without this, `web` starts as soon as
    # the api *container* starts and a reviewer's first page load can 502 while
    # tsx is still warming up. `node -e` rather than curl/wget: node is the one
    # binary this image is guaranteed to have.
    healthcheck:
      test: ['CMD', 'node', '-e', "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
      interval: 3s
      timeout: 3s
      retries: 20
      start_period: 5s

  worker:
    build: { context: ., dockerfile: apps/worker/Dockerfile }
    command: pnpm --filter @marketplace/worker start:loop
    environment:
      DATABASE_URL: postgres://marketplace:marketplace@postgres:5432/marketplace
      CLOSE_INTERVAL_MS: 15000
    depends_on:
      bootstrap: { condition: service_completed_successfully }

  web:
    build:
      context: .
      dockerfile: apps/web/Dockerfile
      args: { VITE_ENABLE_DEV_TOOLS: 'true' }
    ports: ['8080:80']
    depends_on:
      api: { condition: service_healthy }

volumes:
  pgdata:
```

Single published port. The reviewer runs `docker compose up` and opens `http://localhost:8080`; nginx proxies `/api` internally, so there is no CORS configuration anywhere in the codebase.

- [ ] **Step 3: Write CI**

`.github/workflows/ci.yml`:
```yaml
name: CI
on: { push: { branches: [main] }, pull_request: }

jobs:
  verify:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: marketplace
          POSTGRES_PASSWORD: marketplace
          POSTGRES_DB: marketplace_test
        ports: ['5432:5432']
        options: >-
          --health-cmd pg_isready --health-interval 2s
          --health-timeout 3s --health-retries 20
    env:
      DATABASE_URL: postgres://marketplace:marketplace@localhost:5432/marketplace_test
      DATABASE_URL_TEST: postgres://marketplace:marketplace@localhost:5432/marketplace_test
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test                      # pure domain + API middleware
      - run: pnpm db:migrate
      # The reason CI exists in this project: it runs the closer twice against a
      # real Postgres and asserts no double-awards and no budget overrun. The
      # brief's hardest requirement is proved on every push rather than claimed
      # in the README.
      - run: pnpm test:integration
      - run: docker compose build
```

- [ ] **Step 4: Verify the cold-start path**

Run:
```bash
docker compose down -v && docker compose up --build
```
Expected: postgres becomes healthy, `bootstrap` exits 0 having migrated/seeded/settled, api and worker start, `http://localhost:8080` serves the picker, and `curl -s localhost:8080/api/health` returns `{"status":"ok","database":"ok"}`.

Then verify a re-run is clean: `docker compose up` again and confirm `bootstrap` exits 0 with no duplicate-key errors.

*Verified.* Cold start from `docker compose down -v`: postgres healthy → bootstrap migrated, seeded and closed 2 campaigns (`bid_count 4, winners 3, awarded 1190000, budget 1200000` and `bid_count 2, winners 1, awarded 420000, budget 800000`) then exited 0 → api healthy → worker looping → `curl localhost:8080/api/health` returns `{"status":"ok","database":"ok"}` and the SPA fallback serves `/bids` as 200. Only ports 8080 (web) and 5432 (postgres, for inspection) are published; the API is reachable only through nginx, so the codebase contains no CORS configuration.

Full loop through nginx with no manual database access: place a bid (`pending`, fit snapshot 75.37) → `POST /api/dev/campaigns/:id/expire` → phase becomes `awaiting_results` with the campaign still `open` → the looping worker settles it ~15s later and the bid reads `won`. Running the closer twice more inside the container reported `campaignsClosed: 0` both times.

Invariant sweep after all of it: 5 closings over 5 distinct campaigns, **0** campaigns closed with a pending bid, **0** budget overruns, **0** unfinished runs, **0** failed runs.

Two defects this step found:
- `web` declared `depends_on: [api]`, which is start-order only. The API needs a few seconds to boot under `tsx`, so a reviewer's first page load could 502. The api service now has a `/api/health` healthcheck and `web` waits for `condition: service_healthy`.
- A malformed JSON body was answered with **500** and logged as `unhandled error`, even though Fastify's own `FST_ERR_CTP_INVALID_JSON_BODY` already carries `statusCode: 400`. The error handler now passes through any 4xx a Fastify error already carries, logged at `warn` — a bad request should not page anyone.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "build: compose with single-origin nginx, bootstrap ordering, and CI proving the closer is idempotent"
```

---

### Task 14: README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write it, in this order**

1. **What this is** — two sentences and a screenshot.
2. **Run it** — `docker compose up`, open `http://localhost:8080`. Then the 60-second guided demo: pick `@kitchen.kai` → bid on HelloFresh → "Expire deadline now (demo)" → watch it settle. Local dev without Docker as a secondary path.
3. **The loop closes end to end** — spell out that nothing in the demo touches the database, and that the demo control moves a *deadline* while only the worker closes.
4. **Architecture** — the diagram from spec §3, the three deployables, and the boundary rules. Why this isn't microservices (spec §2.3).
5. **Matching** — hard gates vs. genre as a soft signal; the weights and *why* those weights; the saturating curves and the economic argument for them; why ineligible campaigns are shown.
6. **Winner selection** — name it as 0/1 knapsack; the four-step rule; why greedy over exact DP (the market-design argument); why the quality floor is mandatory with the density arithmetic that proves it; the documented worst case and its trigger; the total-order requirement and its link to idempotency.
7. **How the closing job stays correct if it runs twice** — the five layers, the `LIMIT 1` reasoning, the bid/close race and `FOR SHARE`, why not an advisory lock. Point at the tests that prove each claim by name.
8. **Data model** — the DDL, with the four decisions that need defending (cents, the fit snapshot, two states, the closings PK).
9. **Operating this in production** — Deployments for api and static web, `CronJob` for the closer (`--once` already is the entrypoint), migrations as a pre-deploy Job, managed Postgres, probes, and the two correctness SLIs with their queries. Note that `concurrencyPolicy: Forbid` is a nicety, not the guarantee.
10. **Scaling** — the staged path from spec §15, including where vector search legitimately enters (recall, not ranking) and why a global MIP solver is a market-design change rather than an optimisation.
11. **What I deliberately didn't build, and why** — spec §2.2 and §16, including the lock-ordering cost of a creator win cap.
12. **Time spent** — honest breakdown, and what would come next in order.

- [ ] **Step 2: Verify every claim**

Walk the README top to bottom on a clean clone (`git clone` to a temp dir, `docker compose up`) and check each instruction literally. Anything you cannot verify, delete or mark clearly as untested — an unverifiable claim in a README costs more credibility than the feature was worth.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "docs: README covering the run path, matching and selection rules, and production operation"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: §2 → T1/T13, §3 → boundaries enforced by T3–T6, §4 → T2, §5 → T4, §6 → T5, §7 → T6, §8 → T8/T9, §9 → T10–T12, §10 → tests throughout T2/T4/T5/T6/T8/T9, §11 → T13, §12 → T7, §14 → T6/T8, §15 → T14, §16 → T14.

**Known gaps, accepted deliberately:**
- `PATCH /api/bids/:id` from spec §8 is not a separate task — `placeBid` upserts, so repricing goes through `POST /api/campaigns/:id/bids`. One endpoint, one code path, one set of validations. The spec's `PATCH` line is redundant; the README documents the actual surface.
- No web unit tests (spec §16 states this is deliberate).
- `bid_events` has no UI surface. It backs loss reasons and the audit trail; a per-bid timeline view is the first thing to add with spare time.

**Cut order if the day runs short:** T9's integration tests → the `bid_events` timeline → withdraw/reinstate UI → grouped bid list (flat list instead). T1–T8 and T13–T14 are not cuttable.
