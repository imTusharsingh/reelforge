export type RetryDecision = Readonly<{
  retry: boolean;
  nextAttemptAt: Date | null;
}>;

export function retryDecision(
  retryCount: number,
  now: Date,
  retryAfterSeconds: number | null,
  maximumRetries = 5,
): RetryDecision {
  if (!Number.isSafeInteger(retryCount) || retryCount < 0)
    throw new RangeError("retryCount must be a non-negative integer");
  if (!Number.isSafeInteger(maximumRetries) || maximumRetries < 0)
    throw new RangeError("maximumRetries must be a non-negative integer");
  if (retryAfterSeconds !== null && (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds < 0))
    throw new RangeError("retryAfterSeconds must be null or a non-negative number");
  if (retryCount >= maximumRetries) return { retry: false, nextAttemptAt: null };

  const exponentialDelay = Math.min(60 * 60, 30 * 2 ** retryCount);
  const delaySeconds = Math.max(exponentialDelay, retryAfterSeconds ?? 0);
  return {
    retry: true,
    nextAttemptAt: new Date(now.getTime() + delaySeconds * 1000),
  };
}
