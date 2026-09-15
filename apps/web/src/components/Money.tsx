import { asCents, formatEur } from '@marketplace/domain'

/**
 * Cents in, euros out — using the domain's formatter, not a second Intl
 * instance. One currency formatter in the codebase means the API, the seed and
 * the browser cannot disagree about what €12.34 looks like.
 */
export function Money({ cents }: { cents: number }) {
  return <span className="tabular-nums">{formatEur(asCents(cents))}</span>
}
