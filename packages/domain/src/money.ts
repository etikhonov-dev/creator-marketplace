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
