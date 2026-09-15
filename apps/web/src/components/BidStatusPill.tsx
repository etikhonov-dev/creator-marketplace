import type { BidView } from '../api/client.js'

const STYLE: Record<BidView['status'], string> = {
  pending:   'bg-sky-50 text-sky-800 ring-sky-200',
  won:       'bg-emerald-50 text-emerald-800 ring-emerald-200',
  lost:      'bg-slate-100 text-slate-600 ring-slate-200',
  withdrawn: 'bg-slate-50 text-slate-500 ring-slate-200',
}

const LABEL: Record<BidView['status'], string> = {
  pending: 'Pending',
  won: 'Won',
  lost: 'Not selected',
  withdrawn: 'Withdrawn',
}

export function BidStatusPill({ status }: { status: BidView['status'] }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${STYLE[status]}`}>
      {LABEL[status]}
    </span>
  )
}
