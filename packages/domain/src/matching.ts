import { GENRE_AFFINITY, genreAffinity, type Genre } from './genre.js'

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
  const genreScore = genreAffinity(creator.genre, requirements.targetGenre)

  // Saturating at the ceiling. Above ~8% you are in outlier territory, where
  // further increases are noise rather than signal — and an unbounded term
  // would let one freakish week of engagement dominate the whole score.
  //
  // A creator at zero engagement scores zero here and forfeits all 30 points.
  // That is deliberate: engagement is the single most predictive signal of
  // whether a campaign actually performs, so 2M followers with dead comments
  // *should* rank below a smaller creator with a live audience.
  const engagementScore = clamp01(creator.engagementRate / ENGAGEMENT_CEILING)

  // A campaign that states no follower minimum has no natural reference point,
  // and `followers / 0` is both a division by zero and — worse — a component
  // that stops discriminating precisely where nothing else constrains who can
  // bid. AUDIENCE_BASELINE supplies the missing scale.
  const reference = requirements.minFollowers > 0 ? requirements.minFollowers : AUDIENCE_BASELINE
  const audienceRatio = creator.followerCount / reference

  // Log-scaled, so the first doubling above the requirement earns far more than
  // the ninth: 2x the minimum scores 0.30 where a linear ramp would give 0.11.
  // That is the shape consistent with saturating at all — if extra reach stops
  // adding value, the curve should pay out early and flatten, not track scale.
  //
  // Meeting the minimum exactly scores 0, not a floor. The hard gate already
  // answered "does this creator have enough reach"; this component exists to
  // differentiate *among* eligible creators, and a floor would compress that
  // range for no information gain.
  //
  // The `<= 0` guard is for readability rather than safety: log10(0) is
  // -Infinity, which clamp01 would already flatten to 0.
  const audienceScore = creator.followerCount <= 0
    ? 0
    : clamp01(Math.log10(audienceRatio) / Math.log10(AUDIENCE_SATURATION_MULTIPLE))

  const components: ScoreComponent[] = [
    {
      key: 'genre', label: 'Genre match', score: genreScore, weight: FIT_WEIGHTS.genre,
      detail: creator.genre === requirements.targetGenre
        ? `Exact match on ${creator.genre}`
        : genreScore > GENRE_AFFINITY.unrelated
          ? `${creator.genre} is adjacent to ${requirements.targetGenre}`
          : `${creator.genre} is unrelated to ${requirements.targetGenre}`,
    },
    {
      key: 'engagement', label: 'Engagement', score: engagementScore, weight: FIT_WEIGHTS.engagement,
      detail: engagementScore >= 1
        ? `${pct(creator.engagementRate)} — at or above the ${pct(ENGAGEMENT_CEILING)} ceiling`
        : `${pct(creator.engagementRate)} of a ${pct(ENGAGEMENT_CEILING)} ceiling`,
    },
    {
      key: 'audience', label: 'Audience size', score: audienceScore, weight: FIT_WEIGHTS.audience,
      detail: audienceDetail(creator.followerCount, reference, requirements.minFollowers, audienceScore),
    },
  ]

  const weighted = components.reduce((acc, c) => acc + c.score * c.weight, 0)
  return { total: round2(weighted * 100), components }
}

/** Two decimals, matching the NUMERIC(5,2) column the snapshot is stored in. */
const round2 = (n: number): number => Math.round(n * 100) / 100

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n))

const pct = (rate: number): string => `${(rate * 100).toFixed(1)}%`

const count = (n: number): string => n.toLocaleString('en')

/**
 * The copy a creator reads to decide whether this campaign is worth an hour of
 * pitching, so it states the comparison rather than the score: how many
 * followers they have, against what, and whether more would help.
 */
function audienceDetail(
  followerCount: number, reference: number, statedMinimum: number, score: number,
): string {
  const basis = statedMinimum > 0
    ? `the ${count(statedMinimum)} minimum`
    : `a ${count(reference)} baseline (no minimum set)`

  if (followerCount <= 0) return `No audience data — measured against ${basis}`
  if (score >= 1) {
    return `${count(followerCount)} followers — at least ` +
      `${AUDIENCE_SATURATION_MULTIPLE}x ${basis}, where this stops adding score`
  }

  const multiple = followerCount / reference
  return `${count(followerCount)} followers — ` +
    `${multiple < 1 ? multiple.toFixed(2) : multiple.toFixed(1)}x ${basis}`
}
