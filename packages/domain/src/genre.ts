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
