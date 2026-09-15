import type { BidView } from '../api/client.js'

/**
 * Three distinct, actionable messages instead of "Not selected". Each key maps
 * to a real branch in `selectWinners`, and the Record is exhaustive over the
 * LossReason union — adding a branch to the rule is a compile error here until
 * copy exists for it, so the explanation cannot drift from the algorithm.
 */
const LOSS_COPY: Record<NonNullable<BidView['lossReason']>, string> = {
  below_quality_bar:
    'Your match score was below this campaign’s quality bar, so the bid could not win at any price.',
  outranked:
    'The budget was fully committed to bids offering better value per euro.',
  did_not_fit_remaining_budget:
    'Budget remained, but not enough to cover your bid. A lower ask may have fitted.',
}

export function LossReason({ reason }: { reason: BidView['lossReason'] }) {
  if (!reason) return null
  return <p className="mt-1 text-xs text-slate-600">{LOSS_COPY[reason]}</p>
}
