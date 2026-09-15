import type { FitScore } from '@marketplace/domain'

/**
 * Answers "why this score?" — the question that makes the number actionable.
 * A bare 87 tells a creator nothing about what to change; "Genre match: exact,
 * 50% of the score" tells them their genre is already doing the heavy lifting
 * and their engagement is the lever.
 *
 * The weights come from the response, not from a constant here, so the UI
 * cannot disagree with the rule that produced the total.
 */
export function ScoreBreakdown({ fit }: { fit: FitScore }) {
  return (
    <dl className="space-y-2.5">
      {fit.components.map((c) => (
        <div key={c.key} className="grid grid-cols-[6.5rem_1fr_2.5rem] items-center gap-x-3 gap-y-1">
          <dt className="text-sm text-slate-600">{c.label}</dt>
          <dd
            className="h-2 overflow-hidden rounded bg-slate-200"
            role="img"
            aria-label={`${c.label}: ${Math.round(c.score * 100)} out of 100, worth ${Math.round(c.weight * 100)}% of the total`}
          >
            <div className="h-2 rounded bg-slate-800" style={{ width: `${c.score * 100}%` }} />
          </dd>
          <dd className="text-right text-xs tabular-nums text-slate-500">
            {Math.round(c.weight * 100)}%
          </dd>
          <dd className="col-span-3 -mt-0.5 text-xs text-slate-500">{c.detail}</dd>
        </div>
      ))}
    </dl>
  )
}
