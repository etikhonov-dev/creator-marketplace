import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { CreatorProvider } from './state/CreatorProvider.js'
import { App } from './App.js'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The auction settles on a worker tick, so the feed must not serve a
      // cached "biddable" forever. Task 12 tunes this per query.
      staleTime: 5_000,
      retry: 1,
    },
  },
})

const root = document.getElementById('root')
if (!root) throw new Error('#root missing from index.html')

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <CreatorProvider>
          <App />
        </CreatorProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
