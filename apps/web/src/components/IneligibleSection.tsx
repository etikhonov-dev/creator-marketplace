import type { IneligibilityReason } from '@marketplace/domain'
import type { IneligibleCampaign } from '../api/client.js'
import { Money } from './Money.js'
import { GenrePill } from './GenrePill.js'

const compact = (n: number) => new Intl.NumberFormat('en', { notation: 'compact' }).format(n)

/**
 * Built from the discriminated union rather than a message string, so the copy
 * can name the actual numbers — and so adding a gate to `checkEligibility` is a
 * compile error here until someone writes copy for it.
 */
const reasonCopy = (r: IneligibilityReason): string =>
  r.code === 'BELOW_MIN_FOLLOWERS'
    ? `Needs ${compact(r.required)} followers — you have ${compact(r.actual)}`
    : `Needs ${(r.required * 100).toFixed(1)}% engagement — yours is ${(r.actual * 100).toFixed(1)}%`

/**
 * Shown, not hidden. A creator who cannot see the campaigns just out of reach
 * learns nothing about what to grow toward, and `<details>` gives keyboard
 * accessibility and collapse behaviour for free.
 */
export function IneligibleSection({ campaigns }: { campaigns: IneligibleCampaign[] }) {
  if (campaigns.length === 0) return null

  return (
    <details className="mt-8 rounded-lg border border-slate-200 bg-slate-50">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-slate-700">
        Not eligible yet ({campaigns.length})
        <span className="ml-2 font-normal text-slate-500">— what you’d need to qualify</span>
      </summary>
      <ul className="divide-y divide-slate-200 border-t border-slate-200">
        {campaigns.map((c) => (
          <li key={c.id} className="px-4 py-3">
            <div className="flex items-baseline justify-between gap-3">
              <div>
                <span className="text-sm font-medium text-slate-800">{c.brandName}</span>
                <span className="ml-2 text-sm text-slate-600">{c.title}</span>
              </div>
              <div className="flex shrink-0 items-center gap-2 text-xs text-slate-500">
                <GenrePill genre={c.targetGenre} muted />
                <Money cents={c.budgetCents} />
              </div>
            </div>
            <ul className="mt-1.5 space-y-0.5">
              {c.reasons.map((r) => (
                <li key={r.code} className="text-xs text-amber-800">{reasonCopy(r)}</li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </details>
  )
}
