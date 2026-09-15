/**
 * Follower and engagement numbers come from a scraper pipeline we do not own,
 * so the UI states when they were last refreshed. A creator who sees a stale
 * number and no date assumes the platform is wrong about them.
 */
export function StatsFreshness({ statsUpdatedAt }: { statsUpdatedAt: string }) {
  const hours = Math.floor((Date.now() - new Date(statsUpdatedAt).getTime()) / 3_600_000)
  const label = hours < 1 ? 'updated just now'
    : hours < 24 ? `updated ${hours}h ago`
    : `updated ${Math.floor(hours / 24)}d ago`
  const stale = hours >= 24

  return (
    <span className={`text-xs ${stale ? 'text-amber-700' : 'text-slate-500'}`} title={new Date(statsUpdatedAt).toISOString()}>
      Stats {label}
    </span>
  )
}
