import { useNavigate } from 'react-router-dom'
import { useCreator } from '../state/CreatorProvider.js'
import { GenrePill } from '../components/GenrePill.js'
import { StatsFreshness } from '../components/StatsFreshness.js'

export function CreatorPicker() {
  const { creators, loading, error, choose } = useCreator()
  const navigate = useNavigate()

  if (loading) return <p className="p-8 text-slate-500">Loading creators…</p>
  if (error) {
    return (
      <div className="p-8">
        <p className="text-red-700">Could not load creators: {error}</p>
        <p className="mt-2 text-sm text-slate-500">
          Is the API running? Try <code>curl localhost:8080/api/health</code>.
        </p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-semibold text-slate-900">Who are you today?</h1>
      <p className="mt-2 text-sm text-slate-600">
        There is no sign-in in this build. Pick a creator and the app acts as them —
        every request carries their id in an <code>X-Creator-Id</code> header.
      </p>

      <ul className="mt-6 divide-y divide-slate-200 overflow-hidden rounded-lg border border-slate-200 bg-white">
        {creators.map((c) => (
          <li key={c.id}>
            <button
              onClick={() => { choose(c.id); navigate('/campaigns') }}
              className="flex w-full items-center justify-between gap-4 p-4 text-left hover:bg-slate-50"
            >
              <span>
                <span className="block font-medium text-slate-900">{c.displayName}</span>
                <span className="block text-sm text-slate-500">{c.handle}</span>
              </span>
              <span className="flex items-center gap-3 text-right text-sm">
                <GenrePill genre={c.genre} />
                <span className="tabular-nums text-slate-700">
                  {c.followerCount.toLocaleString('en')} followers
                  <span className="block text-xs text-slate-500">
                    {(c.engagementRate * 100).toFixed(1)}% engagement
                  </span>
                </span>
              </span>
            </button>
            <div className="px-4 pb-3"><StatsFreshness statsUpdatedAt={c.statsUpdatedAt} /></div>
          </li>
        ))}
      </ul>
    </div>
  )
}
