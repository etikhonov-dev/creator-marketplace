import type {
  BidView, CreatorView, MatchedCampaignsResponse,
} from '../../../api/src/routes/types.js'

export type { BidView, CreatorView, MatchedCampaignsResponse }

/** The stable error codes the API promises. The UI maps codes to copy. */
export type ApiErrorCode =
  | 'CREATOR_REQUIRED' | 'CREATOR_NOT_FOUND' | 'CAMPAIGN_NOT_FOUND'
  | 'CAMPAIGN_NOT_BIDDABLE' | 'CREATOR_INELIGIBLE' | 'BID_EXCEEDS_BUDGET'
  | 'BID_NOT_FOUND' | 'NOT_BID_OWNER' | 'BID_NOT_EDITABLE'
  | 'VALIDATION_FAILED' | 'DEV_TOOLS_DISABLED' | 'INTERNAL'

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** Set by the creator picker; sent as X-Creator-Id on every request. */
let creatorId: string | null = null
export const setCreatorId = (id: string | null) => { creatorId = id }

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(creatorId ? { 'x-creator-id': creatorId } : {}),
      ...init.headers,
    },
  })

  if (!res.ok) {
    // Trust the documented error envelope, but never assume it: a proxy or a
    // crash can return HTML, and parsing that as JSON would replace a useful
    // status code with a JSON syntax error.
    const body = await res.json().catch(() => null) as
      { error?: { code?: ApiErrorCode; message?: string; details?: unknown } } | null
    throw new ApiError(
      body?.error?.code ?? 'INTERNAL',
      res.status,
      body?.error?.message ?? `Request failed with ${res.status}`,
      body?.error?.details,
    )
  }

  return res.status === 204 ? (undefined as T) : (res.json() as Promise<T>)
}

export const api = {
  listCreators: () => request<CreatorView[]>('/api/creators'),
  matchedCampaigns: () => request<MatchedCampaignsResponse>('/api/campaigns'),
  myBids: () => request<BidView[]>('/api/bids'),
  placeBid: (campaignId: string, body: { amountCents: number; pitch: string | null }) =>
    request<BidView>(`/api/campaigns/${campaignId}/bids`, {
      method: 'POST', body: JSON.stringify(body),
    }),
  withdrawBid: (bidId: string) =>
    request<BidView>(`/api/bids/${bidId}/withdraw`, { method: 'POST' }),
  expireCampaign: (campaignId: string) =>
    request<{ id: string; biddingDeadline: string }>(
      `/api/dev/campaigns/${campaignId}/expire`, { method: 'POST' },
    ),
}
