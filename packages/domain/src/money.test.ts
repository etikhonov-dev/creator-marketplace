import { describe, it, expect } from 'vitest'
import { toCents, centsToEuros, formatEur, parseEuroInput, asCents } from './money.js'

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

describe('asCents', () => {
  it('reattaches the brand to an integer that is already a cent count', () => {
    expect(asCents(1234)).toBe(1234)
    expect(formatEur(asCents(1234))).toBe('€12.34')
  })

  // The point of validating here: the wire is `number`, so without this a float
  // that never went through toCents would travel as if it had.
  it('refuses a non-integer, which is how a float would otherwise sneak in', () => {
    expect(() => asCents(12.5)).toThrow(/not an integer cent amount/)
    expect(() => asCents(NaN)).toThrow()
  })
})
