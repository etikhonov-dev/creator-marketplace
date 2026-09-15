/**
 * Every failure the client is meant to handle is an AppError with a stable
 * `code`. The UI maps codes to copy; it never parses messages. Anything that
 * is not an AppError is a bug and becomes a 500 with no detail leaked.
 */
export class AppError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    readonly statusCode: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export type ApiErrorCode =
  | 'CREATOR_REQUIRED'      // 400 — no X-Creator-Id header
  | 'CREATOR_NOT_FOUND'     // 404
  | 'CAMPAIGN_NOT_FOUND'    // 404
  | 'CAMPAIGN_NOT_BIDDABLE' // 409 — closed, or deadline passed
  | 'CREATOR_INELIGIBLE'    // 422 — fails a hard gate
  | 'BID_EXCEEDS_BUDGET'    // 422 — could never win, so refuse it
  | 'BID_NOT_FOUND'         // 404
  | 'NOT_BID_OWNER'         // 403
  | 'BID_NOT_EDITABLE'      // 409 — already decided
  | 'VALIDATION_FAILED'     // 400
  | 'DEV_TOOLS_DISABLED'    // 404

export const badRequest = (code: ApiErrorCode, msg: string, details?: unknown) =>
  new AppError(code, 400, msg, details)
export const notFound = (code: ApiErrorCode, msg: string) => new AppError(code, 404, msg)
export const forbidden = (code: ApiErrorCode, msg: string) => new AppError(code, 403, msg)
export const conflict = (code: ApiErrorCode, msg: string) => new AppError(code, 409, msg)
export const unprocessable = (code: ApiErrorCode, msg: string, details?: unknown) =>
  new AppError(code, 422, msg, details)
