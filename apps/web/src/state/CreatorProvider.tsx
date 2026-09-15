import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { api, setCreatorId, type CreatorView } from '../api/client.js'

const STORAGE_KEY = 'marketplace.creatorId'

type CreatorContextValue = {
  creator: CreatorView | null
  creators: CreatorView[]
  loading: boolean
  error: string | null
  choose: (id: string | null) => void
}

const CreatorContext = createContext<CreatorContextValue | null>(null)

/**
 * Holds "who am I acting as". There is no auth, so this is a deliberate,
 * visible choice rather than a hidden session — and it is the single place the
 * X-Creator-Id header is set, mirroring the single source of truth on the
 * server.
 */
export function CreatorProvider({ children }: { children: React.ReactNode }) {
  const [creators, setCreators] = useState<CreatorView[]>([])
  const [creator, setCreator] = useState<CreatorView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const choose = useCallback((id: string | null) => {
    // The header is set before any query runs, so a switch cannot race a fetch
    // that still carries the previous identity.
    setCreatorId(id)
    if (id) localStorage.setItem(STORAGE_KEY, id)
    else localStorage.removeItem(STORAGE_KEY)
    setCreator(creators.find((c) => c.id === id) ?? null)
  }, [creators])

  useEffect(() => {
    let cancelled = false
    api.listCreators()
      .then((rows) => {
        if (cancelled) return
        setCreators(rows)
        const saved = localStorage.getItem(STORAGE_KEY)
        const restored = rows.find((c) => c.id === saved) ?? null
        // Restore only if the id still exists: a reset database would otherwise
        // leave the app wedged sending a creator id the server 404s.
        setCreatorId(restored?.id ?? null)
        if (!restored && saved) localStorage.removeItem(STORAGE_KEY)
        setCreator(restored)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load creators')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  return (
    <CreatorContext.Provider value={{ creator, creators, loading, error, choose }}>
      {children}
    </CreatorContext.Provider>
  )
}

export function useCreator() {
  const ctx = useContext(CreatorContext)
  if (!ctx) throw new Error('useCreator must be used inside CreatorProvider')
  return ctx
}
