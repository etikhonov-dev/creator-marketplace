import { Navigate, Route, Routes } from 'react-router-dom'
import { CreatorPicker } from './pages/CreatorPicker.js'
import { useCreator } from './state/CreatorProvider.js'

/** Everything past the picker needs an identity, so it is guarded in one place. */
function RequireCreator({ children }: { children: React.ReactNode }) {
  const { creator, loading } = useCreator()
  if (loading) return <p className="p-8 text-slate-500">Loading…</p>
  if (!creator) return <Navigate to="/" replace />
  return <>{children}</>
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<CreatorPicker />} />
      <Route path="/campaigns" element={<RequireCreator><CampaignsPlaceholder /></RequireCreator>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

// Replaced in Task 11 by the ranked campaign feed. Kept minimal but honest:
// it renders the identity the app is acting as, which is the one thing already
// wired end to end.
function CampaignsPlaceholder() {
  const { creator, choose } = useCreator()
  return (
    <div className="mx-auto max-w-3xl p-8">
      <p className="text-slate-700">
        Acting as <strong>{creator!.displayName}</strong> ({creator!.handle}).
      </p>
      <button onClick={() => choose(null)} className="mt-4 text-sm text-indigo-700 underline">
        Switch creator
      </button>
    </div>
  )
}
