import { MIN_FIT_TO_WIN } from '@marketplace/domain'

const band = (total: number) =>
  total >= 80 ? { label: 'Strong match', cls: 'bg-emerald-50 text-emerald-800 ring-emerald-200' }
  : total >= 60 ? { label: 'Good match',   cls: 'bg-sky-50 text-sky-800 ring-sky-200' }
  : total >= MIN_FIT_TO_WIN ? { label: 'Fair match', cls: 'bg-amber-50 text-amber-800 ring-amber-200' }
  : { label: 'Below quality bar', cls: 'bg-slate-100 text-slate-600 ring-slate-200' }

/**
 * The score, plus the one fact a creator wants before reading anything else:
 * can this bid win at all? A bare number cannot answer that, so the quality
 * bar is drawn on the same scale.
 */
export function FitScoreBadge({ total }: { total: number }) {
  const { label, cls } = band(total)
  const canWin = total >= MIN_FIT_TO_WIN

  return (
    <div className={`rounded-lg px-3 py-2 text-right ring-1 ${cls}`}>
      <div className="text-2xl font-semibold leading-none tabular-nums">{total.toFixed(0)}</div>
      <div className="mt-1 text-[11px] font-medium uppercase tracking-wide">{label}</div>
      <div
        className="relative mt-1.5 h-1 w-24 rounded bg-black/10"
        title={`Quality bar is ${MIN_FIT_TO_WIN}. Bids below it cannot win at any price.`}
      >
        <div className="absolute inset-y-0 left-0 rounded bg-current opacity-70"
             style={{ width: `${Math.min(100, total)}%` }} />
        <div className="absolute -top-0.5 h-2 w-0.5 bg-black/50"
             style={{ left: `${MIN_FIT_TO_WIN}%` }} />
      </div>
      <div className="mt-1 text-[11px]">
        {canWin ? `above the ${MIN_FIT_TO_WIN} bar` : `needs ${MIN_FIT_TO_WIN} to win`}
      </div>
    </div>
  )
}
