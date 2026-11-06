export const RENDER_MAX_RETRIES = 3;
export const RENDER_RETRY_BACKOFF_MS = 250;
export function renderRetryDelayMs(attempt: number, baseMs = RENDER_RETRY_BACKOFF_MS): number {
  return Math.min(60 * 60 * 1000, baseMs * 2 ** Math.max(0, attempt));
}
