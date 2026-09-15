import { Navigate, NavLink, Route, Routes } from 'react-router-dom'
import { CreatorPicker } from './pages/CreatorPicker.js'
import { CampaignFeed } from './pages/CampaignFeed.js'
import { MyBids } from './pages/MyBids.js'
import { useCreator } from './state/CreatorProvider.js'
import { GenrePill } from './components/GenrePill.js'

/** Everything past the picker needs an identity, so it is guarded in one place. */
function RequireCreator({ children }: { children: React.ReactNode }) {
  const { creator, loading } = useCreator()
  if (loading) return <p className="p-8 text-slate-500">Loading…</p>
  if (!creator) return <Navigate to="/" replace />
  return <>{children}</>
}

function Header() {
  const { creator, choose } = useCreator()
  if (!creator) return null

  const link = ({ isActive }: { isActive: boolean }) =>
    `rounded-md px-3 py-1.5 text-sm font-medium ${
      isActive ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
    }`

  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-6 py-3">
        <nav className="flex gap-1">
          <NavLink to="/campaigns" className={link}>Campaigns</NavLink>
          <NavLink to="/bids" className={link}>Your bids</NavLink>
        </nav>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-slate-700">{creator.displayName}</span>
          <GenrePill genre={creator.genre} />
          {/* No sign-out, because there is no session — switching creator is
              the honest label for what this does. */}
          <button onClick={() => choose(null)} className="text-slate-500 underline">
            Switch
          </button>
        </div>
      </div>
    </header>
  )
}

export function App() {
  return (
    <div className="min-h-screen bg-slate-50">
      <Header />
      <Routes>
        <Route path="/" element={<CreatorPicker />} />
        <Route path="/campaigns" element={<RequireCreator><CampaignFeed /></RequireCreator>} />
        <Route path="/bids" element={<RequireCreator><MyBids /></RequireCreator>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  )
}
