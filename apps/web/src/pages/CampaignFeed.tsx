import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type MatchedCampaign } from '../api/client.js'
import { messageFor } from '../api/errorCopy.js'
import { CampaignCard } from '../components/CampaignCard.js'
import { IneligibleSection } from '../components/IneligibleSection.js'
import { BidDrawer } from '../components/BidDrawer.js'
import { StatsFreshness } from '../components/StatsFreshness.js'

export function CampaignFeed() {
  const [drawerFor, setDrawerFor] = useState<MatchedCampaign | null>(null)

  const { data, isPending, error } = useQuery({
    queryKey: ['campaigns'],
    queryFn: api.matchedCampaigns,
    // The auction settles on a worker tick, so a card must not sit on a stale
    // "biddable" indefinitely. Polling is the honest mechanism at this size —
    // spec §15 covers when this becomes a subscription.
    refetchInterval: 5_000,
  })

  if (isPending) return <p className="p-8 text-slate-500">Loading campaigns…</p>
  if (error) {
    return (
      <div className="p-8">
        <p className="rounded-md bg-red-50 p-3 text-red-800">{messageFor(error)}</p>
      </div>
    )
  }

  const { matched, ineligible, creator } = data

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <header className="mb-6">
        <h1 className="text-xl font-semibold text-slate-900">Campaigns for you</h1>
        <p className="mt-1 text-sm text-slate-600">
          Ranked by how well you match, highest first. {matched.length} eligible
          {ineligible.length > 0 && `, ${ineligible.length} just out of reach`}.
        </p>
        <p className="mt-1 text-xs text-slate-500">
          Matched against {creator.followerCount.toLocaleString('en')} followers and{' '}
          {(creator.engagementRate * 100).toFixed(1)}% engagement.{' '}
          <StatsFreshness statsUpdatedAt={creator.statsUpdatedAt} />
        </p>
      </header>

      {matched.length === 0 ? (
        <p className="rounded-lg border border-slate-200 bg-white p-6 text-sm text-slate-600">
          No campaigns match your profile yet. Check “Not eligible yet” below to see
          what you’d need to qualify for the ones that are close.
        </p>
      ) : (
        <ul className="space-y-4">
          {matched.map((c) => (
            <CampaignCard key={c.id} campaign={c} onBid={setDrawerFor} />
          ))}
        </ul>
      )}

      <IneligibleSection campaigns={ineligible} />

      {drawerFor && (
        // Keyed by id so reopening on a different campaign remounts the form
        // rather than carrying the previous campaign's amount across.
        <BidDrawer
          key={drawerFor.id}
          campaign={matched.find((c) => c.id === drawerFor.id) ?? drawerFor}
          onClose={() => setDrawerFor(null)}
        />
      )}
    </div>
  )
}
