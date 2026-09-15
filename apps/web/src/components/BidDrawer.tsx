import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { MIN_FIT_TO_WIN, asCents, formatEur, parseEuroInput } from '@marketplace/domain'
import { api, type MatchedCampaign } from '../api/client.js'
import { messageFor } from '../api/errorCopy.js'
import { Money } from './Money.js'
import { ScoreBreakdown } from './ScoreBreakdown.js'

const PITCH_LIMIT = 500

/**
 * The bid form, and the place the match score has to earn its keep: everything
 * shown here is derived from the *actual* selection rule, so the guidance
 * cannot promise something the auction will not honour.
 *
 * It deliberately does NOT show other creators' bids or a predicted rank.
 * Leaking competitors' prices would change bidding behaviour, and a predicted
 * rank would be a promise the auction cannot keep — winners depend on every
 * other bid placed before the deadline.
 */
export function BidDrawer({
  campaign, onClose,
}: { campaign: MatchedCampaign; onClose: () => void }) {
  const existing = campaign.myBid
  const [amount, setAmount] = useState(() =>
    existing ? (existing.amountCents / 100).toFixed(2) : '')
  const [pitch, setPitch] = useState(() => existing?.pitch ?? '')
  const queryClient = useQueryClient()

  // Escape closes. A drawer you cannot dismiss from the keyboard is a trap.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const cents = parseEuroInput(amount)
  const overBudget = cents !== null && cents > campaign.budgetCents
  const belowBar = campaign.fit.total < MIN_FIT_TO_WIN
  const shareOfBudget = cents !== null && cents > 0
    ? (cents / campaign.budgetCents) * 100
    : null

  const mutation = useMutation({
    mutationFn: () =>
      api.placeBid(campaign.id, { amountCents: cents!, pitch: pitch.trim() || null }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['campaigns'] })
      void queryClient.invalidateQueries({ queryKey: ['bids'] })
      onClose()
    },
  })

  const canSubmit = cents !== null && cents > 0 && !overBudget && !mutation.isPending

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-slate-900/30" onClick={onClose}>
      <aside
        className="h-full w-full max-w-md overflow-y-auto bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Bid on ${campaign.title}`}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              {campaign.brandName}
            </p>
            <h2 className="text-lg font-semibold text-slate-900">{campaign.title}</h2>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-slate-700">✕</button>
        </div>

        <p className="mt-3 text-sm text-slate-600">{campaign.brief}</p>

        <div className="mt-5 rounded-lg border border-slate-200 p-4">
          <div className="mb-3 flex items-baseline justify-between">
            <span className="text-sm font-medium text-slate-700">
              Your match score: {campaign.fit.total.toFixed(0)}
            </span>
            <span className="text-xs text-slate-500">quality bar {MIN_FIT_TO_WIN}</span>
          </div>
          <ScoreBreakdown fit={campaign.fit} />
        </div>

        {belowBar && (
          <p className="mt-4 rounded-md bg-slate-100 p-3 text-sm text-slate-700">
            Your match score is below this campaign’s quality bar, so this bid
            cannot win at any price. You can still place it — the brief may change —
            but a campaign closer to your genre is a better use of your time.
          </p>
        )}

        <form
          className="mt-5 space-y-4"
          onSubmit={(e) => { e.preventDefault(); if (canSubmit) mutation.mutate() }}
        >
          <div>
            <label htmlFor="amount" className="block text-sm font-medium text-slate-700">
              Your price
            </label>
            <div className="mt-1 flex items-center gap-2">
              <span className="text-slate-500">€</span>
              <input
                id="amount"
                inputMode="decimal"
                autoFocus
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="2500.00"
                aria-invalid={overBudget}
                aria-describedby="amount-help"
                className={`w-full rounded-md border px-3 py-2 tabular-nums ${
                  overBudget ? 'border-red-400 bg-red-50' : 'border-slate-300'
                }`}
              />
            </div>
            <div id="amount-help" className="mt-1.5 space-y-1 text-xs">
              <p className="text-slate-500">
                Campaign budget <Money cents={campaign.budgetCents} />. Accepts 2500.00 or 2.500,00.
              </p>
              {overBudget && (
                <p className="text-red-700">
                  Above the whole campaign budget of {formatEur(asCents(campaign.budgetCents))} — this
                  could never win, so it will be refused.
                </p>
              )}
              {!overBudget && shareOfBudget !== null && (
                // The most decision-relevant number: winners are filled by value
                // per euro until the budget runs out, so a smaller share of
                // budget leaves more room for the fill to reach you.
                <p className="text-slate-600">
                  That is <strong>{shareOfBudget.toFixed(0)}%</strong> of the budget.
                  {shareOfBudget > 60
                    ? ' A large share has to beat every cheaper bid on value per euro to win.'
                    : ' Several bids this size can win together.'}
                </p>
              )}
            </div>
          </div>

          <div>
            <label htmlFor="pitch" className="block text-sm font-medium text-slate-700">
              Pitch <span className="font-normal text-slate-400">(optional)</span>
            </label>
            <textarea
              id="pitch"
              rows={3}
              value={pitch}
              maxLength={PITCH_LIMIT}
              onChange={(e) => setPitch(e.target.value)}
              placeholder="How you would approach this brief."
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
            <p className="mt-1 text-right text-xs text-slate-400 tabular-nums">
              {pitch.length}/{PITCH_LIMIT}
            </p>
          </div>

          {mutation.isError && (
            <p className="rounded-md bg-red-50 p-3 text-sm text-red-800">
              {messageFor(mutation.error)}
            </p>
          )}

          <button
            type="submit"
            disabled={!canSubmit}
            className="w-full rounded-md bg-slate-900 px-4 py-2.5 font-medium text-white disabled:opacity-40"
          >
            {mutation.isPending ? 'Submitting…' : existing && existing.status === 'pending'
              ? 'Update bid' : 'Place bid'}
          </button>
        </form>
      </aside>
    </div>
  )
}
