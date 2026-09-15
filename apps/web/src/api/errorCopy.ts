import { ApiError } from './client.js'

/**
 * Maps the API's stable error codes to copy. The UI never parses messages —
 * codes are the contract, so server wording can change without breaking the
 * frontend, and a new code is a missing key here rather than a blank screen.
 */
const COPY: Record<string, string> = {
  CREATOR_REQUIRED: 'Pick a creator first.',
  CREATOR_NOT_FOUND: 'That creator no longer exists. Pick another.',
  CAMPAIGN_NOT_FOUND: 'This campaign no longer exists.',
  CAMPAIGN_NOT_BIDDABLE: 'Bidding has closed for this campaign.',
  CREATOR_INELIGIBLE: 'You do not meet this campaign’s requirements.',
  BID_EXCEEDS_BUDGET: 'Your bid is larger than the whole campaign budget.',
  BID_NOT_FOUND: 'This bid no longer exists.',
  NOT_BID_OWNER: 'That bid belongs to another creator.',
  BID_NOT_EDITABLE: 'This bid has already been decided and can’t be changed.',
  VALIDATION_FAILED: 'Please check the values you entered.',
  DEV_TOOLS_DISABLED: 'Demo controls are turned off in this environment.',
  INTERNAL: 'Something went wrong on our side. Try again.',
}

export function messageFor(error: unknown): string {
  if (error instanceof ApiError) return COPY[error.code] ?? error.message
  // A network failure never reaches the API, so it has no code to map.
  if (error instanceof TypeError) return 'Could not reach the server. Is the API running?'
  return error instanceof Error ? error.message : 'Unexpected error'
}
