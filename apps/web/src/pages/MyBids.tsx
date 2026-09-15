import { useQuery } from '@tanstack/react-query'
import { api, type BidView } from '../api/client.js'
import { messageFor } from '../api/errorCopy.js'
import { Money } from '../components/Money.js'
import { BidStatusPill } from '../components/BidStatusPill.js'
import { LossReason } from '../components/LossReason.js'

/**
 * Grouped, not a flat table. A creator's real questions are "what still needs
 * my attention?" and "what am I waiting on?" — a status column answers neither
 * without them scanning every row.
 */
type Group = { key: string; title: string; hint: string; bids: BidView[] }

function group(bids: BidView[]): Group[] {
  const active: BidView[] = []
  const awaiting: BidView[] = []
  const decided: BidView[] = []

  for (const b of bids) {
    if (b.status === 'pending' && b.campaign.phase === 'biddable') active.push(b)
    else if (b.status === 'pending') awaiting.push(b)
    else decided.push(b)
  }

  return [
    { key: 'active', title: 'Live', hint: 'You can still change these.', bids: active },
    { key: 'awaiting', title: 'Awaiting results', hint: 'Bidding closed; the scheduled job decides these on its next pass.', bids: awaiting },
    { key: 'decided', title: 'Decided', hint: 'Won, not selected, or withdrawn.', bids: decided },
  ].filter((g) => g.bids.length > 0)
}

export function MyBids() {
  const { data, isPending, error } = useQuery({
    queryKey: ['bids'],
    queryFn: api.myBids,
    // Same reason as the feed: a bid moves from pending to won/lost without
    // the user doing anything, so the page has to notice on its own.
    refetchInterval: 5_000,
  })

  if (isPending) return <p className="p-8 text-slate-500">Loading your bids…</p>
  if (error) {
    return <div className="p-8"><p className="rounded-md bg-red-50 p-3 text-red-800">{messageFor(error)}</p></div>
  }

  const groups = group(data)

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <h1 className="text-xl font-semibold text-slate-900">Your bids</h1>

      {groups.length === 0 ? (
        <p className="mt-4 rounded-lg border border-slate-200 bg-white p-6 text-sm text-slate-600">
          You haven’t bid on anything yet. Open <strong>Campaigns</strong> to see what matches you.
        </p>
      ) : (
        <div className="mt-6 space-y-8">
          {groups.map((g) => (
            <section key={g.key}>
              <h2 className="text-sm font-semibold text-slate-800">
                {g.title} <span className="font-normal text-slate-400">({g.bids.length})</span>
              </h2>
              <p className="text-xs text-slate-500">{g.hint}</p>
              <ul className="mt-2 divide-y divide-slate-200 overflow-hidden rounded-lg border border-slate-200 bg-white">
                {g.bids.map((b) => (
                  <li key={b.id} className="p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                          {b.campaign.brandName}
                        </p>
                        <p className="font-medium text-slate-900">{b.campaign.title}</p>
                        {b.pitch && <p className="mt-1 text-sm italic text-slate-500">“{b.pitch}”</p>}
                      </div>
                      <div className="shrink-0 text-right">
                        <BidStatusPill status={b.status} />
                        <p className="mt-1.5 font-medium text-slate-900"><Money cents={b.amountCents} /></p>
                        {/* The score as snapshotted at bid time, not recomputed:
                            this is the number the auction actually used. */}
                        <p className="text-xs text-slate-500 tabular-nums">
                          match {b.fitScoreAtBidTime.toFixed(0)} at bid time
                        </p>
                      </div>
                    </div>
                    <LossReason reason={b.lossReason} />
                    <p className="mt-1.5 text-xs text-slate-400">
                      Placed {new Date(b.createdAt).toLocaleString()}
                      {b.decidedAt && ` · decided ${new Date(b.decidedAt).toLocaleString()}`}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
