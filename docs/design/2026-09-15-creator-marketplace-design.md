# Creator Marketplace — Matching, Bidding, Auction Closing

**Design doc** · 2026-09-15 · time box: 1 day

## 1. Problem

A slice of a creator marketplace: creators are matched and ranked against seeded
campaigns, place bids, and a scheduled job closes expired auctions and selects winners
within budget. No auth — the user picks which creator they are acting as.

The loop must close end to end with no manual database access, and **the closing job must
be safe to run more than once** without double-awarding or exceeding a budget.

## 2. Decisions and rationale

### 2.1 Stack

| Choice | Rationale |
|---|---|
| TypeScript everywhere, pnpm workspace | One `packages/domain` importable by API, worker and tests. The scoring rule shown in the UI is literally the code the auction uses. |
| Fastify, explicitly layered | Small, schema-first (Zod), no built-in scheduler. Nest would earn its boilerplate past ~20 endpoints; its `@nestjs/schedule` would also tempt the closer into the API process. |
| Vite + React SPA | Builds to static assets, so the web tier *structurally cannot* own domain logic. Also the fastest dev loop, which is the product-polish budget. |
| Postgres 16 | The hard requirement is a concurrency problem. `FOR UPDATE SKIP LOCKED`, advisory locks, partial indexes and real isolation are the tools that solve it; SQLite would define the problem away. |
| Drizzle | Domain types derived from the schema, and locking SQL is first-class rather than an `$queryRaw` escape hatch (which is where Prisma would land for the one query that matters most). |

### 2.2 Deliberately not built

- **SSR / Next.js.** No public indexable pages, no SEO, every byte is per-creator and
  dynamic. Would add a Node tier to operate and tempt a second data-access path.
  Trigger to revisit: brand-shareable public campaign pages.
- **Native / Flutter.** Breaks "runnable by pulling the repo" (SDK + Xcode + emulator),
  and buys nothing for a browse-and-bid surface. Layout is mobile-first responsive
  instead. Trigger to revisit: content capture and push notifications.
- **Kubernetes manifests.** A reviewer needs minutes-to-working; a cluster costs 20+
  minutes and can fail on their machine for reasons we can't debug. Production shape is
  described in the README and *demonstrated* by the worker's `--once` mode, which is
  exactly a `CronJob` entrypoint.
- **Traefik.** nginx with a 15-line reverse proxy gives single-origin routing (and
  therefore no CORS). Traefik would add a service and label-based config to learn.
- **Auth, payments, third-party integrations.** Out of scope per the brief. A
  `X-Creator-Id` request-context plugin marks the seam where auth would attach.

## 3. Architecture

```
                    ┌───────────────────────────┐
   browser ────────▶│ web (nginx)               │
                    │  • serves static dist/    │
                    │  • proxies /api  ─────────┼──┐   single origin, no CORS
                    └───────────────────────────┘  │
                                                   ▼
                    ┌──────────────────────────────────────┐
                    │ api (Fastify)                        │
                    │  routes → services → repositories    │
                    │  owns: matching display, bid writes   │
                    └───────────────┬──────────────────────┘
                                    │
   ┌────────────────────────────┐   ▼                ┌────────────────────┐
   │ worker                     │  Postgres 16 ◀─────│ packages/db        │
   │  --once  (k8s CronJob)     │───────▶            │  schema/migrations │
   │  --loop  (compose demo)    │                    │  seed              │
   │  owns: auction closing     │                    └────────────────────┘
   └──────────────┬─────────────┘
                  │            ┌──────────────────────────────────┐
                  └───────────▶│ packages/domain  (pure, no I/O)  │◀── api
                               │  eligibility · fit score         │
                               │  winner selection · money        │
                               └──────────────────────────────────┘
```

**Boundary rules:**

- `packages/domain` performs no I/O. Every function is pure and unit-testable, and it is
  the only place a business rule may live.
- **Only the worker closes auctions.** There is no HTTP path from a request to winner
  selection. The dev-tools endpoint mutates a *deadline*, never an outcome.
- `packages/db` owns schema, migrations, seed and the client factory. Each app writes its
  own queries — shared repositories across two services would become a god-package and
  couple their release cycles.

## 4. Data model

See `packages/db/src/schema.ts` for the source of truth. Target SQL:

```sql
CREATE TYPE genre           AS ENUM ('beauty','fashion','fitness','gaming','music','food','tech','travel');
CREATE TYPE campaign_status AS ENUM ('open','closed');
CREATE TYPE bid_status      AS ENUM ('pending','won','lost','withdrawn');
CREATE TYPE bid_event_type  AS ENUM ('placed','repriced','withdrawn','reinstated','won','lost');

CREATE TABLE creators (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    handle          VARCHAR(64)  NOT NULL UNIQUE,
    display_name    TEXT         NOT NULL,
    genre           genre        NOT NULL,
    follower_count  INT          NOT NULL CHECK (follower_count >= 0),
    engagement_rate NUMERIC(5,4) NOT NULL CHECK (engagement_rate BETWEEN 0 AND 1),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE campaigns (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_name          TEXT            NOT NULL,
    title               TEXT            NOT NULL,
    brief               TEXT            NOT NULL,
    target_genre        genre           NOT NULL,
    min_followers       INT             NOT NULL DEFAULT 0 CHECK (min_followers >= 0),
    min_engagement_rate NUMERIC(5,4)    NOT NULL DEFAULT 0 CHECK (min_engagement_rate BETWEEN 0 AND 1),
    budget_cents        BIGINT          NOT NULL CHECK (budget_cents > 0),
    bidding_deadline    TIMESTAMPTZ     NOT NULL,
    status              campaign_status NOT NULL DEFAULT 'open',
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT now()
);

-- The closer's hot path. Partial, so it only ever indexes campaigns awaiting closure
-- and stays small as the campaigns table grows without bound.
CREATE INDEX campaigns_open_by_deadline_idx
    ON campaigns (bidding_deadline) WHERE status = 'open';

CREATE TABLE bids (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id  UUID         NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    creator_id   UUID         NOT NULL REFERENCES creators(id)  ON DELETE CASCADE,
    amount_cents BIGINT       NOT NULL CHECK (amount_cents > 0),
    fit_score    NUMERIC(5,2) NOT NULL CHECK (fit_score BETWEEN 0 AND 100),
    pitch        TEXT         NULL,
    status       bid_status   NOT NULL DEFAULT 'pending',
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    decided_at   TIMESTAMPTZ  NULL,
    CONSTRAINT bids_one_per_creator_per_campaign UNIQUE (campaign_id, creator_id),
    CONSTRAINT bids_decided_at_matches_status
        CHECK ((status IN ('won','lost')) = (decided_at IS NOT NULL))
);

CREATE INDEX bids_by_creator_idx ON bids (creator_id, created_at DESC);
-- No index on bids(campaign_id): the UNIQUE constraint's btree already leads with it.

CREATE TABLE campaign_closings (
    campaign_id         UUID PRIMARY KEY REFERENCES campaigns(id) ON DELETE RESTRICT,
    closed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    bid_count           INT         NOT NULL CHECK (bid_count >= 0),
    winning_bid_count   INT         NOT NULL CHECK (winning_bid_count >= 0),
    total_awarded_cents BIGINT      NOT NULL CHECK (total_awarded_cents >= 0),
    CONSTRAINT closings_winners_within_bids CHECK (winning_bid_count <= bid_count)
);

CREATE TABLE bid_events (
    id           BIGSERIAL PRIMARY KEY,
    bid_id       UUID           NOT NULL REFERENCES bids(id) ON DELETE CASCADE,
    type         bid_event_type NOT NULL,
    amount_cents BIGINT         NULL,
    fit_score    NUMERIC(5,2)   NULL,
    actor        TEXT           NOT NULL,   -- 'creator' | 'closer'
    metadata     JSONB          NOT NULL DEFAULT '{}',
    created_at   TIMESTAMPTZ    NOT NULL DEFAULT now()
);
CREATE INDEX bid_events_by_bid_idx ON bid_events (bid_id, id);
```

### 4.1 Why these choices

**Money is `BIGINT` cents.** No float ever touches a budget. `INT` would cap at
€21.4M/campaign — not a bug today, but money columns are the ones you least want to
`ALTER` later (a table rewrite under `ACCESS EXCLUSIVE`), and the saving is 4 bytes/row.
Euro→cent conversion happens once, at the HTTP boundary.

**`fit_score` is snapshotted on the bid, not recomputed at close.** The score that was
shown to the creator is the score that decides their bid. Recomputing means a creator who
gained followers — or a tweak to the weights — is judged differently than the number they
saw, and you can no longer explain a loss. It also makes the closer a pure function of
committed data: **deterministic and replayable**, which is what makes "safe to run twice"
tractable rather than merely hoped-for.

**Two stored campaign states, three derived.** `status` answers exactly one question: does
this accept bids. Outcome is already recorded precisely in
`campaign_closings.winning_bid_count`; storing it again on the campaign row would let two
representations of one fact drift. The UI derives:

```
biddable = status='open' AND bidding_deadline >  now()
awaiting = status='open' AND bidding_deadline <= now()   → "Bidding closed, results pending"
settled  = status='closed'                                → won/lost, or "no winners selected"
```
That middle state is not cosmetic — it is the real window between deadline and the
worker's next tick, and without it the app looks broken for ~15 seconds.

**Genre is a native enum.** Matching depends on `target_genre` equalling `creators.genre`;
free text lets a seed typo silently produce zero matches with no error. The enum also
gives Drizzle a TS union, so the matching code is type-checked against valid genres.

**`bids_decided_at_matches_status`** makes "a won bid with no decision timestamp"
unrepresentable. Same philosophy as the numeric CHECKs: push invariants to where they
cannot be bypassed by a bug in application code.

**`campaign_closings` is `ON DELETE RESTRICT` while `bids` is `CASCADE`.** Deliberate and
opposite: a child row with no standalone meaning should vanish with its parent; an audit
row must *block* deletion of the thing it audits.

**`bid_events` uses `BIGSERIAL`** for monotonic ordering and append-only index inserts.
`actor` records which *component* acted — with no auth we cannot record a person, but
"creator or closer?" is the question you actually ask when debugging a disputed bid.
Events are written **in the same transaction as the mutation they describe**; an audit log
that can survive a rolled-back transaction is a log that lies.

## 5. Matching

### 5.1 Hard gates

- `follower_count >= campaign.min_followers`
- `engagement_rate >= campaign.min_engagement_rate`

Contractual floors the brand set: 30k is not a worse match for a 50k requirement, it is a
no.

### 5.2 Genre is a soft signal, not a gate

As a gate, matching collapses to `WHERE genre = ?` and the fit score has nothing left to
explain. It is also less true to the business — a fitness creator promoting a protein bar
for a *food* campaign is a deal that gets done. So:

```
exact    → 1.0
adjacent → 0.6    fitness↔food, beauty↔fashion, gaming↔tech, music↔gaming, travel↔food
unrelated→ 0.2
```

### 5.3 Fit score — weighted sum of saturating components

```
genreFit      = adjacency(creator.genre, campaign.target_genre)   weight 0.50
engagementFit = min(1, engagement / ENGAGEMENT_CEILING)           weight 0.30
audienceFit   = min(1, log10(followers / reference) / log10(10))  weight 0.20

  where reference = min_followers > 0 ? min_followers : AUDIENCE_BASELINE
        ENGAGEMENT_CEILING = 0.08
        AUDIENCE_BASELINE  = 10_000

fit = 100 * Σ (component × weight)
```

`log10(10)` is 1, so the denominator is there for readability: it names the saturation
point (10× the reference) instead of hiding it in a magic constant.

**The zero-minimum case.** Roughly half of a realistic campaign set sets no follower
minimum, and `min_followers = 0` would make `reference` zero — division by zero, and
conceptually every creator would score a perfect 1.0, so the component would stop
discriminating on exactly the campaigns where it matters most. A campaign with no stated
minimum still prefers a larger audience to a tiny one. So an unstated minimum falls back to
`AUDIENCE_BASELINE` (10k), meaning 100k followers saturates. This is a judgement call and
the constant is exported and tested, not buried.

**Weights.** Genre relevance is what the brand is actually buying, so it dominates.
Engagement predicts campaign performance better than raw reach. Follower count is the most
commoditized signal of the three, so it counts least.

**Why the curves saturate.** "More followers is better" is economically wrong: a campaign
needing 10k followers gets no extra value from a 5M creator, who will be expensive — the
brand pays for reach it did not ask for. So audience fit reaches 1.0 at 10× the minimum and
stops. Engagement saturates at 8%, which is exceptional in practice. Saturating rather than
linear curves are what make the score feel calibrated instead of arbitrary.

### 5.4 The score returns its breakdown

```ts
{ total: 87, components: [
  { key:'genre',      label:'Genre match',   score:1.0, weight:0.5, detail:'Exact: fitness' },
  { key:'engagement', label:'Engagement',    score:0.8, weight:0.3, detail:'6.4% vs 8% target' },
  { key:'audience',   label:'Audience size', score:0.7, weight:0.2, detail:'320k · 6× the 50k minimum' },
]}
```
A bare `87%` gives a creator nothing actionable. The breakdown tells them genre is perfect
and engagement is carrying them, which is what lets them decide what to bid.

### 5.5 Ineligible campaigns are shown, not hidden

In a separate collapsed section — never mixed into the ranked list — with the specific
reason ("needs 50k followers, you have 32k"). Hiding them is less code; showing them tells
a creator what to grow toward. That is the difference between a filter and a product.

## 6. Winner selection

The problem is **0/1 knapsack**: maximize value over a bid subset subject to
`Σ amount ≤ budget`.

### 6.1 The rule

1. **Quality floor.** A bid with `fit_score < MIN_FIT_TO_WIN` (40) cannot win at any price.
2. **Rank** survivors by value density `fit_score / amount_cents`, descending.
3. **Fill with continuation.** Walk the ranked list, taking any bid that fits in the
   remaining budget. Do *not* stop at the first that doesn't fit — skip it and continue.
4. Everything else is `lost`, with a recorded reason.

### 6.2 Why greedy and not exact DP

Exact DP is computationally cheap here, and rejected on **product** grounds:

> Under DP, whether you win depends combinatorially on the whole set of other bids. There
> is no threshold price — you cannot tell a creator "bid under €X to win", because no such
> X exists. And a small change to one bid reshuffles the optimal subset, flipping *other*
> creators' outcomes for reasons unrelated to them. An auction whose rule you can't explain
> feels rigged, and that is a commercial problem, not an aesthetic one.

Greedy density gives every creator an individually comprehensible rule: improve your fit or
lower your price and your rank improves. Position depends on your own numbers.

### 6.3 Why the quality floor is required

Naive `fit/price` makes the cheapest junk win: fit 20 at €10 has density 2.0, fit 90 at
€1,000 has 0.09. Any value-per-euro rule needs a quality bar — which is also how real
marketplaces work: brands set a minimum standard, then optimize spend within it. The floor
lives as an exported constant in `packages/domain`, trivially promotable to a per-campaign
column.

### 6.4 Honest caveat

Greedy-by-density has a known worst case (budget €100; a €1 bid at fit 2 and a €100 bid at
fit 100 — greedy takes the cheap one). It does not arise when individual bids are a small
fraction of the budget, which is this marketplace's shape. If bids routinely approached the
full budget, the fix is two lines: also evaluate the single best affordable bid and take
whichever total is higher, which carries a proven 2-approximation bound.

### 6.5 Determinism — the part that ties back to idempotency

**The comparator must be a total order or the "idempotent" job is not deterministic.** Two
bids with equal density are ordered arbitrarily by an unstable sort, or by whatever order
Postgres happened to return rows — which can differ between runs. So:

```
density desc → fit desc → created_at asc → id asc
```

The final key never decides anything meaningful, and that is precisely why it must be
there. The same applies in SQL: any `ORDER BY` whose result feeds a decision ends with a
unique column.

### 6.6 Loss reasons

Because the rule is explainable, each losing bid gets a real reason in
`bid_events.metadata`:

- `below_quality_bar` — fit was under the campaign's minimum
- `outranked` — the budget was spent by higher value-per-euro bids before yours
- `did_not_fit_remaining_budget` — €400 remained when your €1,200 bid was considered

## 7. The closing job

### 7.1 Threat model

Overlapping cron schedules; a pod restarting after partial work; a manual re-run; a k8s
`CronJob` with `concurrencyPolicy: Allow`; two replicas coexisting during a rollout.

### 7.2 Five layers

**L1 — claim work with a row lock**

```sql
SELECT * FROM campaigns
 WHERE status = 'open' AND bidding_deadline <= now()
 ORDER BY bidding_deadline, id
 FOR UPDATE SKIP LOCKED
 LIMIT 20;
```
`FOR UPDATE` locks the rows for the transaction; `SKIP LOCKED` means a second worker does
not block — it skips them and claims different campaigns, so N workers process disjoint
sets in parallel. This is how you build a work queue in Postgres without Redis or SQS.

**L2 — the state transition is the guard.** `status='open'` is evaluated under the lock, so
a campaign another worker already closed is simply not in the result set. Idempotency is
the query predicate, not a bolted-on check.

**L3 — one transaction per campaign.** Close campaign → mark winners → mark losers → write
events → insert closing record → commit. Crash midway and it all rolls back: the campaign
is still `open` with `pending` bids for the next run to redo cleanly. A partially-closed
auction is never visible. Per-campaign rather than per-batch so one poisoned campaign can't
roll back the other nineteen and locks are held for milliseconds.

**L4 — structural backstop.** `campaign_closings.campaign_id` is the PRIMARY KEY, so even
if every line of the locking logic were wrong, a second close attempt dies on a unique
violation. Defence that does not depend on our code being correct.

**L5 — budget invariant.** Selection asserts `Σ winning amounts ≤ budget_cents` before
commit, and `total_awarded_cents` is persisted for audit. A true DB-level constraint on a
cross-row sum needs a trigger or materialized aggregate — over-engineering today, but the
named upgrade if real money moved.

### 7.3 The bid/close race

Worker locks a campaign and reads its bids. In that window a bid `INSERT` lands — the
request checked `deadline > now()` a millisecond earlier and passed. The worker commits.
That bid is `pending` forever on a closed auction: invisible in testing, and a real creator
silently losing their bid.

Fix: the bid-placement path takes `SELECT … FROM campaigns WHERE id = $1 FOR SHARE` before
validating the deadline. `FOR SHARE` permits concurrent bids but **blocks the closer's
`FOR UPDATE`**, so the two paths serialize and cannot interleave. Prevention, not a cleanup
sweep.

### 7.4 Why not an advisory lock

`pg_try_advisory_lock('close-auctions')` is one line and guarantees a single closer, but it
serializes the whole job: no horizontal scaling, and one stuck run blocks all closing.
`SKIP LOCKED` gives the same safety at per-campaign granularity plus parallelism. The wider
lesson for the README: **`concurrencyPolicy: Forbid` is an operational nicety, never a
correctness guarantee.** Correctness lives in the database.

### 7.5 Run modes

```
worker --once   single pass, exits 0   → exactly a k8s CronJob entrypoint
worker --loop   polls every CLOSE_INTERVAL_MS (15s in compose) → the demo
```
`--once` being safe is free, because the idempotency work above is required anyway. This
*demonstrates* the production shape rather than asserting it.

## 8. API surface

```
GET   /api/health
GET   /api/creators                   creator picker — the only identity-free route
GET   /api/campaigns                  { matched: [...ranked], ineligible: [...+reasons] }
GET   /api/bids                       my bids + campaign summary + outcome reason
POST  /api/campaigns/:id/bids         { amountCents, pitch }  (upsert: also reinstates)
PATCH /api/bids/:id                   { amountCents, pitch }  re-snapshots fit_score
POST  /api/bids/:id/withdraw
POST  /api/dev/campaigns/:id/expire   gated by ENABLE_DEV_TOOLS; sets deadline = now()
```

`ENABLE_DEV_TOOLS` defaults to **false**, and `docker-compose.yml` sets it to `true`
explicitly. So the reviewer gets the demo control without any config, while the default for
any other deployment is off — the safe direction for a flag to fail. The route mutates a
deadline only; it has no access to winner selection.

**Identity comes from exactly one place: the `X-Creator-Id` header.** A Fastify
request-context plugin resolves it to `req.creator` (404 if unknown), and every route
except `GET /api/creators` requires it. So `/api/campaigns` means "campaigns matched for
me" and `/api/bids` means "my bids" — no `:creatorId` path parameter anywhere.

The first draft of this used `/api/creators/:id/campaigns` for reads and the header for
writes. That is two sources of truth for "who am I", and the bug it invites is obvious in
hindsight: a request whose path says one creator and whose header says another. With one
source, that request is unrepresentable.

With no auth this is not security. It marks the seam where auth attaches — swap the plugin
for one that reads a verified JWT and no route changes.

Errors are `{ error: { code, message, details? } }` with codes the UI maps to copy:
`CAMPAIGN_NOT_BIDDABLE`, `CREATOR_INELIGIBLE`, `BID_EXCEEDS_BUDGET`, `BID_NOT_FOUND`,
`NOT_BID_OWNER`. A bid above the whole budget is rejected rather than accepted-and-lost:
it can never win, so accepting it would be a lie.

## 9. Web app

Screens: creator picker → ranked campaign feed → bid drawer → my bids.

- **Feed** — ranked cards with fit score + component breakdown, budget, deadline countdown.
  Collapsed "Not eligible yet (n)" section with per-campaign reasons.
- **Bid drawer** — euro input, optional pitch, and honest guidance derived from the real
  rule: the campaign's budget, the quality floor, and "at €800 you'd be asking 16% of the
  budget". It does not leak other creators' bids.
- **My bids** — status pills (pending / awaiting results / won / lost), amount, fit at bid
  time, outcome reason, and edit/withdraw while biddable.

**Reflecting the worker without a refresh:** TanStack Query with a 5s `refetchInterval` on
the feed and bids queries. Polling is the right call at this scale; the production upgrade
is SSE or a websocket, noted in the README.

Mobile-first responsive — creators genuinely bid from phones — via Tailwind.

## 10. Testing strategy

`packages/domain` (pure unit, vitest):
- eligibility gates at boundaries (exactly at `min_followers`)
- saturation: 10× minimum followers = 1.0, 100× also 1.0
- weights sum to 1.0
- `selectWinners`: budget never exceeded; quality floor honoured; continuation past an
  unaffordable bid; **shuffled input yields identical output** (determinism)
- documented worst case reproduced as a test so the caveat is verified, not asserted

`apps/worker` (integration, real Postgres):
1. an expired campaign awards winners within budget
2. **running the closer twice leaves byte-identical state** — snapshot, re-run, compare
3. two closers concurrently: no double awards, no budget overrun
4. a campaign with zero bids closes with zero winners
5. a campaign before its deadline is untouched
6. a bid at the deadline boundary either lands before close or is rejected — never
   orphaned as `pending` on a closed campaign

`apps/api`: route tests for validation, ineligible-bid rejection, and withdraw ownership.

Web: no unit tests. Deliberate — with one day, the marginal bug caught per minute is far
higher in the auction logic, and the UI is verified by walking the loop.

## 11. Infrastructure

- `docker-compose.yml`: `postgres`, `api`, `worker`, `web` (nginx serving `dist/` and
  proxying `/api`). One command, single origin, no CORS. nginx stands in for the
  ingress/CDN that would sit there in production.
- Migrations run as a one-shot step before the API starts, not on API boot — the same
  ordering a pre-deploy `Job` gives you in k8s.
- `.github/workflows/ci.yml`: typecheck → lint → domain unit tests → integration tests
  against a Postgres service container, **including the run-it-twice test**. CI is the
  highest-value infra per minute here because it proves the brief's hardest requirement
  instead of claiming it in prose.
- Production story lives in the README: Deployments for api and web, `CronJob` for the
  closer, migrations as a pre-deploy Job, managed Postgres, readiness/liveness probes,
  what to alert on (campaigns past deadline still `open` beyond N minutes is the key SLI).

## 12. Seed data

Designed so the app is interesting the moment it opens:

- ~8 creators spanning genres, follower counts (12k → 1.2M) and engagement (1.1% → 7.8%),
  including some deliberately ineligible for some campaigns.
- ~10 campaigns with a spread of deadlines:
  - **2 already closed**, with winners and losers, so won/lost state is visible on first
    load before the reviewer has bid on anything
  - 1 past deadline but unclosed, to show the "results pending" state
  - 2 closing within minutes
  - the rest days out
- Enough pre-existing bids on the closed campaigns that the budget actually binds and the
  greedy rule visibly rejects someone.

**The seed does not hand-write closed state.** It inserts campaigns with past deadlines
plus `pending` bids, then invokes the real closing routine once. Two benefits: the seeded
`won`/`lost`/`campaign_closings`/`bid_events` rows are by construction exactly what the
production code path produces — there is no second, fictional implementation of closing
that could drift from the real one — and seeding doubles as a smoke test of the closer on
every fresh boot.

**The seed is idempotent.** Fixed UUIDs for creators and campaigns plus
`ON CONFLICT DO NOTHING`, so `docker compose up` a second time does not duplicate data or
re-close settled auctions. A `--reset` flag truncates first, for when you want a clean
demo run.

## 13. Time budget (~10h) and cut order

| Phase | Est. |
|---|---|
| Scaffold, schema, migrations, seed | 1.5h |
| `packages/domain` + unit tests | 1.5h |
| API (routes, services, repositories) | 1.5h |
| Worker + integration tests | 1.5h |
| Web app | 2.5h |
| Compose, CI, README | 1.5h |

Cut in this order if time runs short: API route tests → `bid_events` UI surface →
withdraw/reinstate → bid editing. The auction logic, its tests, and the README are not
cuttable; they are what is being graded.
