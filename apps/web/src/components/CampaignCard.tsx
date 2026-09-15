import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { MatchedCampaign } from '../api/client.js'
import { api } from '../api/client.js'
import { messageFor } from '../api/errorCopy.js'
import { Money } from './Money.js'
import { GenrePill } from './GenrePill.js'
import { FitScoreBadge } from './FitScoreBadge.js'
import { ScoreBreakdown } from './ScoreBreakdown.js'
import { DeadlineCountdown } from './DeadlineCountdown.js'
import { LossReason } from './LossReason.js'
import { ExpireCampaignButton } from './ExpireCampaignButton.js'

/**
 * One card, three phases, and a primary action that is a pure function of
 * (phase, myBid). Every combination is handled explicitly rather than falling
 * back to a disabled button, because "nothing happened and I don't know why"
 * is the failure mode of a feed like this.
 */
export function CampaignCard({
  campaign, onBid,
}: { campaign: MatchedCampaign; onBid: (c: MatchedCampaign) => void }) {
  const queryClient = useQueryClient()
  const bid = campaign.myBid

  const withdraw = useMutation({
    mutationFn: (bidId: string) => api.withdrawBid(bidId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['campaigns'] })
      void queryClient.invalidateQueries({ queryKey: ['bids'] })
    },
  })

  return (
    <li className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              {campaign.brandName}
            </span>
            <GenrePill genre={campaign.targetGenre} />
          </div>
          <h3 className="mt-0.5 font-semibold text-slate-900">{campaign.title}</h3>
          <p className="mt-1 text-sm text-slate-600">{campaign.brief}</p>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
            <span>Budget <Money cents={campaign.budgetCents} /></span>
            <span>Min {campaign.minFollowers.toLocaleString('en')} followers</span>
            {campaign.phase === 'biddable'
              ? <DeadlineCountdown deadline={campaign.biddingDeadline} />
              : <span>Closed {new Date(campaign.biddingDeadline).toLocaleString()}</span>}
          </div>
        </div>
        <div className="shrink-0"><FitScoreBadge total={campaign.fit.total} /></div>
      </div>

      <details className="mt-3">
        <summary className="cursor-pointer text-xs font-medium text-slate-600">
          Why this score?
        </summary>
        <div className="mt-2 rounded-md bg-slate-50 p-3"><ScoreBreakdown fit={campaign.fit} /></div>
      </details>

      <div className="mt-3 border-t border-slate-100 pt-3">
        {campaign.phase === 'biddable' && (
          <div className="flex flex-wrap items-center gap-3">
            {bid && bid.status === 'pending' ? (
              <>
                <span className="text-sm text-slate-700">
                  Your bid: <strong><Money cents={bid.amountCents} /></strong>
                </span>
                <button onClick={() => onBid(campaign)}
                        className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white">
                  Edit bid
                </button>
                <button onClick={() => withdraw.mutate(bid.id)} disabled={withdraw.isPending}
                        className="text-sm text-slate-600 underline disabled:opacity-50">
                  {withdraw.isPending ? 'Withdrawing…' : 'Withdraw'}
                </button>
              </>
            ) : (
              <button onClick={() => onBid(campaign)}
                      className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white">
                {bid?.status === 'withdrawn' ? 'Bid again' : 'Place bid'}
              </button>
            )}
            {withdraw.isError && (
              <span className="text-sm text-red-700">{messageFor(withdraw.error)}</span>
            )}
          </div>
        )}

        {campaign.phase === 'awaiting_results' && (
          // The real gap between a deadline and the worker's next pass. Naming
          // it is the difference between "settling" and "the app is broken".
          <p className="flex items-center gap-2 text-sm text-slate-600">
            <span className="inline-block size-2 animate-pulse rounded-full bg-amber-500" />
            Bidding closed — the scheduled job picks winners on its next pass.
            {bid && bid.status === 'pending' && ' Your bid is in.'}
          </p>
        )}

        {campaign.phase === 'settled' && (
          <div className="text-sm">
            {bid?.status === 'won' && (
              <p className="font-medium text-emerald-800">
                You won · <Money cents={bid.amountCents} />
              </p>
            )}
            {bid?.status === 'lost' && (
              <>
                <p className="text-slate-700">Not selected</p>
                <LossReason reason={bid.lossReason} />
              </>
            )}
            {bid?.status === 'withdrawn' && <p className="text-slate-500">You withdrew this bid</p>}
            {!bid && <p className="text-slate-500">Closed — you didn’t bid on this one</p>}
          </div>
        )}

        {campaign.phase === 'biddable' && <ExpireCampaignButton campaignId={campaign.id} />}
      </div>
    </li>
  )
}
