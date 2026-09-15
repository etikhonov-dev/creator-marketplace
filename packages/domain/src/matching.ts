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

// `genreAffinity` is imported for the genre component above; referenced here so
// the scaffold typechecks before that component is written.
void genreAffinity
