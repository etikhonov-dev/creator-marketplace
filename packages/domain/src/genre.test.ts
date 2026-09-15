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
