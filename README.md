# Creator Marketplace — matching, bidding, and a closing job that is safe to run twice

A creator signs in as themselves (no auth — you pick who you are), sees campaigns
ranked by how well they match and *why*, places a price, and a scheduled worker
closes expired auctions and selects winners within budget. The loop closes end to
end with no manual database access.

The interesting part is not the CRUD. It is that **the closing job is correct when
it runs concurrently with itself, when it runs twice, and when a bid lands in the
millisecond before the deadline** — and that the correctness lives in Postgres
transactions and constraints rather than in application discipline.

---

## Run it

```bash
docker compose up --build        # first run builds images; later runs start in seconds
open http://localhost:8080
```

That is the whole setup. `docker compose` brings up Postgres, runs a **bootstrap**
job (migrate → seed → settle already-expired seed auctions), waits for the API to
report healthy, then starts the API, the looping worker, and nginx serving the SPA.

**Ports:** only `8080` (web) and `5432` (Postgres, so you can inspect it). The API
is *not* published — nginx proxies `/api` to it internally, which is why there is
no CORS configuration anywhere in this codebase.

### The 60-second demo

1. Pick **@kitchen.kai** (food, 34k followers, 7.1% engagement).
2. The feed is ranked by match score. Expand **“Why this score?”** on HelloFresh —
   the breakdown is the point, not the number.
3. Note **“Not eligible yet (5)”** at the bottom: campaigns just out of reach, each
   naming the exact shortfall (*“Needs 50k followers — you have 34k”*).
4. Bid **€2,500** on *HelloFresh — Weeknight recipe series*. The drawer tells you
   that is 36% of the budget, and warns you if your score is below the quality bar.
5. Click the amber **“Expire deadline now (demo)”** on that card.
6. Watch the card move to **“Bidding closed — the scheduled job picks winners on
   its next pass”**, then to **won** within ~15 seconds. No refresh, no SQL.

**What step 5 actually does matters.** It moves a *deadline* — that is the entire
scope of `POST /api/dev/campaigns/:id/expire`. It cannot close an auction, select
winners, or touch a bid. The worker remains the only thing that closes anything,
so the loop you are watching is the real one and not a demo shortcut.

That endpoint exists only when `ENABLE_DEV_TOOLS=true`, which **only
`docker-compose.yml` sets**. When it is false the route is never registered, so
the 404 comes from Fastify's router rather than from a handler that decided not to
act — there is no code path behind the flag for a bug to reach. On the client the
same flag is a Vite build-time constant, so the button is *eliminated from the
bundle*: a default build contains zero occurrences of its copy.

### Without Docker

```bash
docker run -d --name pg -e POSTGRES_USER=marketplace -e POSTGRES_PASSWORD=marketplace \
  -e POSTGRES_DB=marketplace -p 5432:5432 postgres:16-alpine
cp .env.example .env
pnpm install
pnpm bootstrap                                     # migrate + seed + settle
pnpm --filter @marketplace/api    dev              # :3000
pnpm --filter @marketplace/worker start:loop       # closes every 15s
pnpm --filter @marketplace/web    dev              # :5173, proxies /api to :3000
```

### Tests

```bash
pnpm typecheck                                     # tsc -b across the workspace
pnpm test                                          # unit: domain + API middleware
# Integration tests need a real Postgres and their own database:
docker exec -it pg psql -U marketplace -d marketplace -c 'CREATE DATABASE marketplace_test'
DATABASE_URL=postgres://marketplace:marketplace@localhost:5432/marketplace_test pnpm db:migrate
pnpm test:integration                              # schema, closer, bidding
```

The integration suite runs with `--no-file-parallelism`. That is not decoration:
`fileParallelism: false` inside a Vitest *workspace project* is silently ignored
(the option is honoured only at the root), and without serialisation one test file
truncates shared tables underneath another. The symptom was the schema suite's
primary-key-violation assertion turning into a foreign-key error.

---

## Architecture

```
                     ┌──────────────────────┐
  browser ──────────▶│  nginx  (web image)  │  static SPA + /api proxy
                     └──────────┬───────────┘  one origin, so no CORS
                                │
                     ┌──────────▼───────────┐
                     │  api   (Fastify 5)   │  routes → services → repositories
                     │  reads + writes bids │  NEVER closes an auction
                     └──────────┬───────────┘
                                │
                     ┌──────────▼───────────┐       ┌────────────────────────┐
                     │   Postgres 16        │◀──────│ worker  --once/--loop  │
                     │   constraints are    │       │ the ONLY thing that    │
                     │   the last line of   │       │ closes auctions        │
                     │   defence            │       └────────────────────────┘
                     └──────────────────────┘
```

Three deployables, two shared packages:

| Unit | Responsibility | Knows nothing about |
|---|---|---|
| `packages/domain` | every business rule, as pure functions | Postgres, HTTP, the clock |
| `packages/db` | schema, migrations, seed, test factories | business rules |
| `apps/api` | HTTP surface, identity, read models | winner selection |
| `apps/worker` | claiming and closing auctions | HTTP |
| `apps/web` | presentation | how fit is computed |

**Boundary rules that are actually enforced, not just described:**

- `packages/domain` performs **no I/O and never reads the clock**. Time is an
  injected parameter. This is what makes `selectWinners` a pure function of
  committed data, and therefore replayable.
- **No HTTP route can invoke winner selection.** Nothing in `apps/api` imports
  `selectWinners`. The worker is the only caller.
- `apps/api` and `apps/worker` write their own queries. There is deliberately no
  shared repository layer, which would couple their release cycles into a
  god-package.
- The web app imports the API's response types **type-only** across the app
  boundary. The bundle contains no API code, but a response-shape change is a
  frontend compile error rather than a runtime surprise.

### Why this isn't three microservices

WePush runs a fleet of services on Kubernetes, so the expected answer is probably
"split it". I didn't, and the reason is where the *transaction boundary* falls.

Closing an auction must atomically: lock the campaign, read its pending bids,
decide winners, update every bid, write the audit events, and flip the campaign to
closed. Put bids and campaigns in different services and that single transaction
becomes a distributed one — you are now writing a saga with compensating actions
for "un-award a bid", and the budget invariant becomes eventually consistent. The
brief's hardest requirement is *"safe to run more than once without picking winners
twice or exceeding a budget"*. A local `SERIALIZABLE`-adjacent transaction gives
that for free; a saga makes it the hardest part of the system.

The cut I *would* make first, and the reason it is a real cut: **the scraper
pipeline that produces follower and engagement numbers.** It has a different
failure domain (third-party APIs, rate limits, backfills), a different scaling
shape (batch), and it communicates through data rather than behaviour — a
`creators` projection with a `stats_updated_at` column, which is already in the
schema and already surfaced in the UI. That is a service boundary. "Bidding
service" and "campaign service" are not; they are one aggregate with a seam drawn
through the middle of a transaction.

---

## Matching

### Hard gates vs. soft signals

Two things are **contractual floors** the brand set, so they gate:

- `min_followers` — inclusive. Exactly meeting the requirement passes.
- `min_engagement_rate` — inclusive.

**Genre is deliberately *not* a gate.** Cross-genre deals happen constantly: a
food brand is plausibly served by a fitness creator talking about protein. Gating
on genre would hide those campaigns entirely; scoring on it ranks them below the
obvious fits, which is what you actually want.

Ineligible campaigns are **shown, not hidden**, in a collapsed “Not eligible yet”
section with the exact gap named. `IneligibilityReason` is a discriminated union
carrying `required` and `actual` numbers rather than a message string, so the UI
can say *“Needs 500k followers — you have 128k”*. A creator who cannot see the
campaigns just out of reach learns nothing about what to grow toward — that is the
difference between a filter and a product. It also means adding a new gate is a
compile error in the UI until someone writes copy for it.

### The fit score

`scoreFit` returns a total in `0..100` **and a per-component breakdown**, which
the UI renders. The breakdown is the deliverable, not the number: a bare `87` is
not actionable, whereas *“Genre match: exact — 50% of the score”* tells a creator
that their genre is already doing the work and engagement is the lever.

```
total = 100 × ( 0.50 × genreFit  +  0.30 × engagementFit  +  0.20 × audienceFit )

genreFit      = exact 1.0 | adjacent 0.6 | unrelated 0.2
engagementFit = min(1, rate / ENGAGEMENT_CEILING)                 ENGAGEMENT_CEILING = 0.08
audienceFit   = saturating in followers / reference               AUDIENCE_SATURATION_MULTIPLE = 10
                reference = min_followers > 0 ? min_followers : AUDIENCE_BASELINE   (10 000)
```

**Why genre is weighted highest (0.50).** It is the only component that predicts
whether the *content* will be right. Engagement and audience predict how many
people see it. A brand would rather reach 30k of the right audience than 300k of
the wrong one, and the whole premise of creator marketing is audience fit over
audience size.

**Why both curves saturate, and why that is an economic argument rather than a
clamp.** A campaign requiring 10k followers gets no additional value from a 5M
creator — but that creator will be dramatically more expensive, and price is the
other half of winner selection. An unbounded audience term would rank exactly the
creators who blow the budget. Saturating at 10× the requirement says "enough is
enough", and leaves price to do the remaining work. Same for engagement: above 8%
you are in outlier territory and further increases are noise, not signal.

**Why the `AUDIENCE_BASELINE` fallback exists.** With `min_followers = 0`,
`followers / 0` is a division by zero — but the real bug is subtler. Conceptually
every creator would score a perfect audience fit, so the component would stop
discriminating *precisely* on the campaigns where nothing else constrains who can
bid. The baseline keeps it meaningful. (Found during spec self-review, not by a
user.)

**Adjacency is stored as unordered pairs** and the lookup set is derived from them,
so symmetry holds by construction rather than by vigilance — there is exactly one
place each relationship is written down, and a test asserts symmetry across all
64 genre pairs.

**A property of these weights worth knowing:** exact genre alone is worth 50
points, which is already above the quality bar of 40. An unrelated-genre creator
maxing out both other components reaches 60. So genre is not merely weighted
highest, it is close to decisive — which is the intended behaviour, but it is a
choice, not a consequence.

### Why scoring happens in application code, not SQL

At this size the whole campaign set is a few dozen rows and the loop is trivial.
Keeping the rule in `packages/domain` means it is unit-testable in isolation,
shared verbatim by the API and the seed, and cannot drift between them. The
migration path when that stops being true is in **Scaling** below, along with the
signal that it is time.

---

## Winner selection

This is **0/1 knapsack**: maximise total fit subject to the sum of awarded prices
not exceeding the budget, where each bid is all-or-nothing.

The rule, in four steps:

1. **Drop every bid below `MIN_FIT_TO_WIN` (40).** Reason recorded:
   `below_quality_bar`.
2. **Sort the survivors by value density — `fitScore / amountCents` — descending**,
   through a total order (below).
3. **Walk the sorted list, awarding any bid that fits in the remaining budget.**
4. **Continue past bids that don't fit** rather than stopping at the first one.

### Why the quality floor is mandatory, not a nicety

Pure value-per-euro makes the cheapest junk win, and the arithmetic is stark:

| bid | fit | price | density |
|---|---|---|---|
| A | 20 | €10 | **2.0** |
| B | 90 | €1,000 | 0.09 |

A wins by a factor of 22. Without a floor the auction systematically selects
creators who are cheap *because* they are a bad fit. Real marketplaces work the
same way: brands set a quality bar first, then optimise spend within it.

The floor lives as a constant in `packages/domain` rather than a `campaigns`
column because no brand-side UI exists to set it. Promoting it is a migration plus
reading the value off the row; nothing about the function changes.

### Why greedy, and not an exact DP

Exact 0/1 knapsack by dynamic programming is entirely tractable here — budgets in
cents with a few dozen bids. I chose not to use it, and the reason is market
design rather than performance.

Under exact DP a creator's outcome depends **combinatorially on every other bid**.
There is no threshold price: lowering your ask by €1 can flip you out of the
winning set because it changes which *other* subset fits. You cannot give a
creator any advice, because no monotone relationship exists between their own
actions and their outcome, and outcomes reshuffle non-locally when an unrelated
bid changes.

Greedy density gives every creator a rule they can act on: **raise your fit or
lower your price and your rank improves — always.** For a two-sided marketplace
that participants have to trust and learn, a slightly worse allocation with a
legible rule beats an optimal allocation that behaves like a lottery.

Worth knowing: **fractional knapsack is solved *optimally* by exactly this greedy
algorithm.** The 0/1 constraint — bids are all-or-nothing — is the only reason it
is approximate here.

### The documented worst case

Greedy's cost is pinned as a test rather than hand-waved in prose:

| bid | fit | price | density |
|---|---|---|---|
| tiny | 41 | €1 | 0.41 |
| big | 100 | €1,000 | 0.001 |

With a budget of exactly €1,000: greedy buys `tiny` first on density, then cannot
afford `big`. Total fit **41**, with €999 of the budget unspent. The optimal
allocation is `big` alone — fit **100**, budget fully used. The trigger is a bid
that is both very cheap and *just* over the quality bar, against a bid that fills
the budget exactly. `packages/domain/src/winners.test.ts` asserts this, so the
caveat is verified rather than claimed — and if someone later swaps in a better
algorithm, that test tells them the trade-off changed.

### The total order, and why it is an idempotency requirement

```
1. density desc    — the economic rule
2. fit desc        — at equal value, prefer quality
3. createdAt asc   — reward committing early
4. id asc          — arbitrary, but total
```

Key 4 never decides anything meaningful, which is exactly why it must be there.
`Array.prototype.sort` is only *stable* with respect to the input order — so if
two equal-density bids can compare `0`, the closer's output depends on the order
Postgres happened to return rows in. Re-running it could then award a different
set, and **“safe to run twice” would be false no matter how good the locking is.**
Idempotency is not only a concurrency property; it requires the decision function
to be deterministic. A test asserts that shuffling 24 bids under six different
seeds produces identical winners.

### Loss reasons

Losing bids carry one of three reasons, each mapping to a real branch:

- `below_quality_bar` — *“Your match score was below this campaign's quality bar,
  so the bid could not win at any price.”*
- `outranked` — *“The budget was fully committed to bids offering better value per
  euro.”*
- `did_not_fit_remaining_budget` — *“Budget remained, but not enough to cover your
  bid. A lower ask may have fitted.”*

The UI copy is an exhaustive `Record` over the `LossReason` union, so adding a
branch to `selectWinners` is a compile error until copy exists for it. The
explanation cannot drift from the algorithm.

---

## How the closing job stays correct if it runs twice

Six layers. None of them relies on the job being *called* carefully.

**L1 — claim with `FOR UPDATE SKIP LOCKED`, inside the closing transaction.**

```sql
SELECT * FROM campaigns
 WHERE status = 'open' AND bidding_deadline <= now()
 ORDER BY bidding_deadline, id
 FOR UPDATE SKIP LOCKED
 LIMIT 1;
```

`LIMIT 1`, not a batch, and this is the bug the plan caught: **a row lock lives
exactly as long as the transaction that took it.** Claiming 20 campaigns in one
transaction and closing each in its own would release every lock before any
closing work began, and a concurrent worker could claim campaigns this one
believed it owned. So the closer claims one campaign per transaction and loops up
to `MAX_CAMPAIGNS_PER_RUN`. `SKIP LOCKED` is what makes N workers scale
horizontally instead of queueing behind each other.

**L2 — `status = 'open'`, evaluated under the lock, is the actual idempotency
guard.** Under `READ COMMITTED`, when `FOR UPDATE` blocks on a row another
transaction is modifying, Postgres re-evaluates the `WHERE` clause after acquiring
the lock. A campaign closed while we waited stops matching and vanishes from the
result. The lock does not make the close idempotent — it makes *evaluating the
predicate* safe.

**L3 — one transaction per campaign.** A crash mid-run rolls back cleanly and
leaves the campaign claimable. Partial progress across campaigns is fine because
each is independent.

**L4 — `campaign_closings.campaign_id` is a `PRIMARY KEY`.** A structural
backstop: if every line of the locking logic were wrong, a second close raises a
unique violation and the transaction aborts. `schema.integration.test.ts` asserts
the database refuses the duplicate.

**L5 — budget assertion before commit.** If the selected total ever exceeds the
budget, the closer throws. The transaction rolls back and the campaign stays open
rather than committing an overrun.

**L6 — completeness assertion: every pending bid leaves with a decision.** Found
by running the closer against a deliberately broken selection: the campaign closed
with `bid_count: 4` while all four bids stayed `pending`. Since a closed campaign
is no longer claimable, those bids would have been **stranded permanently** —
invisible in every UI and unrecoverable without manual SQL. Now
`outcomes.length !== pendingBids.length` rolls the transaction back.

### The bid/close race, and `FOR SHARE`

A bid placed a millisecond before the deadline could land *after* the closer read
that campaign's bids and *before* it committed — leaving a `pending` bid on a
closed auction forever. The fix is one keyword on the bid path:

```ts
const [campaign] = await tx.select().from(campaigns)
  .where(eq(campaigns.id, input.campaignId)).limit(1).for('share')
```

Share locks are compatible with each other, so many bids proceed concurrently —
but a share lock **blocks** the closer's `FOR UPDATE`. The window closes.
`FOR UPDATE` on the bid path would also be correct and would needlessly serialise
every bid on a campaign against every other.

### Why not an advisory lock

`pg_advisory_lock('close-auctions')` around the whole job is the obvious
alternative and it is worse on two counts: it serialises the entire job, so you
can never scale the closer horizontally, and it guards the *job* rather than the
*data* — anything that closes a campaign
outside that code path bypasses it entirely. Row-level locks guard the rows, which is where the invariant lives.

Kubernetes' `concurrencyPolicy: Forbid` is in the same category: a useful
operational nicety that reduces wasted work, and **never** a correctness
guarantee. A `CronJob` can overlap during a slow run, a node partition, or a
manual `kubectl create job --from=cronjob`.

### The tests that prove each claim

`apps/worker/src/close-auctions.integration.test.ts`, against a real Postgres:

| Test | Proves |
|---|---|
| `is idempotent: a second run changes nothing` | full state fingerprint identical; exactly 1 closing row; exactly 5 decision events |
| `is safe under two workers running concurrently` | two separate connection pools, `campaignsClosed` sums to **1** |
| `closes campaigns in deadline order, oldest first` | the `ORDER BY` is honoured under `SKIP LOCKED` |
| `honours maxCampaigns` | one run cannot monopolise the worker |
| `ignores withdrawn bids` | withdrawn stays withdrawn, `decided_at` stays null |
| `refuses to close a campaign while any pending bid is left undecided` | L6 rolls back, campaign stays open |
| `is deterministic under any input ordering` (unit) | the comparator is a total order |

Separately verified by hand: **three** concurrent workers against one campaign
with 12 bids produced `campaignsClosed: [1, 0, 0]`, exactly one closing row,
`awarded == budget`, and zero pending bids left. And after the full demo loop, an
invariant sweep showed 0 campaigns closed with a pending bid, 0 budget overruns,
0 unfinished runs, 0 failed runs.

---

## Data model

```sql
CREATE TYPE genre           AS ENUM ('beauty','fashion','fitness','gaming','music','food','tech','travel');
CREATE TYPE campaign_status AS ENUM ('open','closed');
CREATE TYPE bid_status      AS ENUM ('pending','won','lost','withdrawn');
CREATE TYPE bid_event_type  AS ENUM ('placed','repriced','withdrawn','reinstated','won','lost');

creators          (id, handle UNIQUE, display_name, genre, follower_count,
                   engagement_rate NUMERIC(5,4), stats_updated_at, created_at)
campaigns         (id, brand_name, title, brief, target_genre, min_followers,
                   min_engagement_rate, budget_cents BIGINT, bidding_deadline,
                   status, created_at)
closing_runs      (id, started_at, finished_at, campaigns_closed, bids_decided,
                   total_awarded_cents, error)
bids              (id, campaign_id, creator_id, amount_cents BIGINT,
                   fit_score NUMERIC(5,2), pitch, status, created_at,
                   updated_at, decided_at)
campaign_closings (campaign_id PK, run_id, closed_at, bid_count,
                   winning_bid_count, total_awarded_cents)
bid_events        (id BIGSERIAL, bid_id, type, amount_cents, fit_score,
                   actor, run_id, metadata JSONB, created_at)

-- The closer's hot path. Partial, so it indexes only campaigns awaiting closure
-- and stays small as the table grows without bound.
CREATE INDEX campaigns_open_by_deadline_idx ON campaigns (bidding_deadline)
  WHERE status = 'open';

-- finished_at IS NULL with an old started_at is a crashed worker. Partial, so
-- that alert query is cheap.
CREATE INDEX closing_runs_unfinished_idx ON closing_runs (started_at)
  WHERE finished_at IS NULL;

CREATE UNIQUE INDEX bids_one_per_creator_per_campaign ON bids (campaign_id, creator_id);

-- Makes "a won bid with no decision timestamp" unrepresentable.
CONSTRAINT bids_decided_at_matches_status
  CHECK ((status IN ('won','lost')) = (decided_at IS NOT NULL))
```

Ten `CHECK` constraints are live in the database and five integration tests assert
that it **refuses** bad data — a negative follower count, an engagement rate of
1.5, a zero budget, a `won` bid with no `decided_at`, a duplicate closing row.
Those tests do not depend on application code being correct, which is the point.

### The four decisions worth defending

**Money is integer cents in `BIGINT`, never a float.** `10.05 * 100` is
`1005.0000000000001` and `1.005 * 100` is `100.49999999999999` — rounding the
*product* of a lossy multiply silently loses a cent. `toCents` scales by shifting
the decimal exponent in the string (`Number("1.005e2")` is exactly `100.5`), so
there is no error to correct for. `Cents` is a branded type, so `formatEur(1234)`
is a **compile error**: no code path can reach a money formatter without having
gone through the conversion. `asCents()` is the one named, validating boundary
where the brand is reattached to integers arriving from the wire.

**`fit_score` is snapshotted onto the bid, and the closer never recomputes it.**
Two reasons. Auditability: the score a creator was shown when they chose their
price is provably the score that decided their bid, even if the weights change
next week. And purity: the closer becomes a function of committed data only,
which is what makes replay and the determinism test meaningful.

**Two stored campaign states, three presentation phases.** `open | closed` in the
database; `biddable | awaiting_results | settled` derived in a repository
function. `awaiting_results` is not cosmetic — it is the real window between a
deadline passing and the worker's next tick, and without naming it the app looks
broken for ~15 seconds. Storing it would mean a third state someone has to keep
in sync with the clock; deriving it cannot go stale. (My first instinct was an
`expired` status, which was wrong: it conflates lifecycle with outcome, and
outcome already lives in `campaign_closings.winning_bid_count`.)

**`ON DELETE RESTRICT` on the audit FK, `CASCADE` on bids — deliberately
opposite.** Deleting a campaign should take its bids with it. It should *not* be
able to silently erase the record that an auction was settled and money was
committed. The audit row refuses to go quietly.

### Observability is in the schema, not only the logs

`closing_runs` plus a `run_id` on `campaign_closings` and `bid_events` exists
because the on-call question runs **row → run**: *"why does this bid say lost?"*
You need to get from the row to the run that decided it, then to that run's
totals and its log lines. Logs are ephemeral and sampled; a foreign key is not.
Verified end to end: after the demo, `bid_events` shows `placed` by `creator`
with no `run_id`, then `won` by `closer` **with** the `run_id` set.

The API honours an inbound `x-request-id` and echoes it back, generating one when
absent, so a browser request and the server span share an identifier.

---

## Operating this in production

**Deployments / Jobs**

- **api** — `Deployment`, N replicas, stateless. Readiness probe on
  `/api/health`, which checks the dependency the process cannot work without
  (`SELECT 1`) so Kubernetes stops routing traffic when Postgres is unreachable.
  Liveness on a plain process check — a liveness probe that fails on a database
  outage restarts every pod during an incident, which is strictly worse than
  serving 503s.
- **web** — the image is `nginx:alpine` plus static files, **no Node runtime at
  all**. In production this is a bucket behind a CDN and the nginx container
  disappears; the `/api` proxy block is standing in for an Ingress.
- **worker** — `CronJob` every minute. `--once` already *is* a CronJob
  entrypoint: one pass, then exit with a meaningful status code. `--loop` exists
  for the Compose demo so a reviewer doesn't wait on cron.
- **migrations** — a pre-deploy `Job`, never on API boot. N replicas booting
  simultaneously would race on the migration lock; more importantly, schema
  changes should be able to fail the *deploy* rather than crash-loop the app.
  `docker compose`'s `bootstrap` service with
  `condition: service_completed_successfully` is exactly that ordering.

**Postgres** — managed (RDS/Cloud SQL), not a container. PITR, automated
failover, and connection pooling are not things worth building for a marketplace
that moves money.

**Configuration** fails fast: both services parse their environment through Zod at
boot and refuse to start on anything invalid, reporting *every* problem at once.
This is not theoretical — it caught a real inconsistency during this build, where
the API accepted `LOG_LEVEL=silent` and the worker rejected it, while Compose
feeds both services one variable. A config layer that warned and defaulted would
have hidden that until deploy.

**The two SLIs that actually matter** are correctness, not latency, and both are
one query:

```sql
-- Auctions that should have closed and didn't. Alert if > 0 for 5 minutes.
-- Uses campaigns_open_by_deadline_idx.
SELECT count(*) FROM campaigns
 WHERE status = 'open' AND bidding_deadline < now() - interval '2 minutes';

-- Worker runs that started and never finished: a crashed or wedged closer.
-- Uses closing_runs_unfinished_idx.
SELECT count(*) FROM closing_runs
 WHERE finished_at IS NULL AND started_at < now() - interval '5 minutes';
```

Two more worth a dashboard, both of which should be **identically zero** forever
— if either is ever non-zero, a correctness layer has failed and the invariant
sweep above is the query to run:

```sql
SELECT count(*) FROM campaign_closings cl JOIN campaigns c ON c.id = cl.campaign_id
 WHERE cl.total_awarded_cents > c.budget_cents;                        -- budget overrun

SELECT count(*) FROM campaigns c JOIN bids b ON b.campaign_id = c.id
 WHERE c.status = 'closed' AND b.status = 'pending';                   -- stranded bid
```

**Where auth attaches.** Identity comes from exactly one place: the
`X-Creator-Id` header, resolved by one Fastify plugin into `request.creator`.
This is explicitly **not** authentication — it is the seam where authentication
goes. Swap that plugin for one that reads a verified JWT and no route changes.
An earlier draft took the creator from a `:creatorId` path parameter on reads and
this header on writes; two sources of truth make a request whose path says
creator A and whose header says creator B *representable*. With one source it is
not. Ownership checks (e.g. on withdraw) live in the service layer rather than the
route, so adding real auth later doesn't require finding every mutation.

**CI** runs typecheck, both suites against a real Postgres, and `docker compose
build`. The integration suite is the reason CI exists here: the brief's hardest
requirement is re-proved on every push instead of claimed in this file.

---

## Scaling

Staged, with the trigger for each stage rather than a rewrite up front.

1. **Now** — score in application code. A few dozen campaigns; the loop is free.
2. **Thousands of campaigns** — move eligibility into a set-based SQL query using
   the partial index, and score only the survivors. *Trigger: the feed query
   exceeds ~100ms.*
3. **Hundreds of thousands** — precompute a `creator_campaign_match` table on
   campaign publish and on stats refresh, and read it. *Trigger: scoring cost
   dominates the request.* This is also the point where the scraper pipeline
   should already be its own service.
4. **Semantic matching** — genre as an 8-value enum is the crudest possible
   content model. Real fit involves brand-safety signals, audience demographics,
   past campaign performance. Those are high-dimensional, which is where
   pgvector with an HNSW index legitimately enters — **for recall, not for
   ranking.** ANN retrieves a candidate set; the deterministic, explainable rule
   still does the ordering. That split matters: a creator can be told why they
   rank where they do, and the closing job stays a pure function of committed
   data.

**On ANN + a global MIP solver.** It is a genuinely better *algorithm* for a
different problem. Two objections. First, ANN is the wrong index for three
low-dimensional features, and price — the dominant term in winner selection — is
not in the embedding at all, so pruning by vector similarity prunes on the wrong
axis. Second and more fundamental: a global MIP allocating creators across
campaigns is **not an optimisation of this system, it is a different market.**
Today creators name a price and a per-campaign auction clears. A global solver
means the platform assigns creators to campaigns, which changes who the customer
is, what a creator can promise, and what the product owes them. (Also correct in
the analysis I was sent: a per-campaign budget is a knapsack constraint on a
weighted sum, so min-cost max-flow genuinely cannot express it natively — MIP is
the right tool *if* you take that product turn.)

The trigger for MIP is a product change, not a load level: batched allocation
rounds, or creator capacity becoming a hard cross-campaign constraint.

**And that last one is the expensive change.** A cap of "at most 3 active
campaigns per creator" breaks the closer's parallelism, because two campaigns
being closed concurrently by different workers can both want the same creator.
You need a second lock tier — lock the affected creator rows, in a deterministic
order (`ORDER BY id`) to avoid deadlock — before deciding either campaign. That
is a real cost, which is why "100 campaigns a day per creator" and "use a MIP
solver" are the same question wearing different clothes.

---

## What I deliberately didn't build

| Skipped | Why |
|---|---|
| **Auth / sessions** | The brief says no auth. Building it would have consumed the time that went into the closing job, and the seam is in place. |
| **Payments / the ledger** | Winning a bid commits to a price; it moves no money. A ledger is a double-entry, audit-first subsystem and is the least sensible thing to fake. |
| **TikTok / Instagram integrations, scrapers** | Faked data with a `stats_updated_at` column and *"Stats updated 3h ago"* in the UI — modelling stats as a **projection we don't own** is the architecturally load-bearing part; polling third-party APIs is not. |
| **Brand-side campaign creation** | Campaigns are seeded. The brief's loop is creator-side, and a second CRUD surface would have added no graded value. |
| **Kubernetes manifests** | Described above instead. Compose is the honest choice for "a reviewer can run this", and unrun manifests are a liability. |
| **Real-time push (WS/SSE)** | The UI polls every 5s. At this cadence polling is simpler and has no reconnection semantics to get wrong. The API shape doesn't change when this flips. |
| **Exact-DP winner selection** | Argued above — a market-design choice, not a shortcut. |
| **Creator win caps** | The lock-ordering cost above. Worth doing when the product asks for it, not before. |

Known limits, stated rather than hidden:

- **Greedy is not optimal.** The worst case is pinned as a test with its trigger.
- **No pagination.** The feed returns every campaign. Fine at seed scale, stage 2
  above otherwise.
- **`bid_events` grows unboundedly.** It wants a retention policy or partitioning
  by month.
- **The 5s poll is per client.** 10k concurrent creators is 2k req/s of identical
  reads; a short-TTL cache or a push channel is the answer, not a bigger database.
- **One currency.** No `currency` column, deliberately — adding one without
  exchange-rate handling would be worse than not having it.

---

## Time spent

Roughly a day, weighted deliberately:

| | Share | Why |
|---|---|---|
| Design + spec + plan | ~40% | Written down as `docs/design/*.md` before code. The spec self-review alone caught a division by zero in the audience curve, two sources of truth for identity, and a seed that would have been a second implementation of winner selection. |
| Domain + worker + schema | ~30% | The graded core. Correctness here is the thing that can't be retrofitted. |
| API + web | ~25% | |
| Compose, CI, this file | ~5% | |

Writing the plan and then executing it found **more than twenty defects in my own
design and plan** before they reached a reviewer — every one recorded in the git
history with its reasoning. Among them: a batched `FOR UPDATE` that
would have released its locks before doing any work, a `Number.EPSILON` nudge
twelve orders of magnitude too small to do its job, a silently-ignored Vitest
option that made the suite pass on ordering luck, every unknown URL answering
`400` instead of `404`, and a malformed JSON body returning `500`. Every one of
them is in the git history with the reasoning.

**Next, in order:** (1) a property-based test comparing greedy's total fit against
exact DP over random inputs, to quantify the approximation gap rather than assert
one example; (2) pagination and the set-based eligibility query; (3) real auth
behind the existing seam; (4) `bid_events` retention.
