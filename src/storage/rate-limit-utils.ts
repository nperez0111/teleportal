import type { RateLimitState } from "./types";

/**
 * Calculate the number of tokens to add based on elapsed time
 *
 * @param elapsedMs - Time elapsed since last refill in milliseconds
 * @param windowMs - Time window for the rate limit in milliseconds
 * @param maxMessages - Maximum number of messages allowed in the window
 * @returns Number of tokens to add
 */
export function calculateTokensToAdd(
  elapsedMs: number,
  windowMs: number,
  maxMessages: number,
): number {
  if (elapsedMs < 0) return 0;
  if (windowMs <= 0) return maxMessages;

  // Calculate tokens to add: (elapsed / window) * maxMessages
  return (elapsedMs / windowMs) * maxMessages;
}

/**
 * Refill the rate limit state based on elapsed time
 *
 * @param state - Current rate limit state
 * @param now - Current timestamp in milliseconds
 * @returns Updated rate limit state
 */
export function refillRateLimitState(
  state: RateLimitState,
  now: number,
): RateLimitState {
  const elapsed = now - state.lastRefill;

  if (elapsed <= 0) {
    return state;
  }

  const tokensToAdd = calculateTokensToAdd(
    elapsed,
    state.windowMs,
    state.maxMessages,
  );

  const newTokens = Math.min(state.maxMessages, state.tokens + tokensToAdd);

  return {
    ...state,
    tokens: newTokens,
    lastRefill: now,
  };
}

/**
 * Create an initial rate limit state
 *
 * @param windowMs - Time window for the rate limit in milliseconds
 * @param maxMessages - Maximum number of messages allowed in the window
 * @returns Initial rate limit state
 */
export function createInitialState(
  windowMs: number,
  maxMessages: number,
): RateLimitState {
  return {
    tokens: maxMessages,
    lastRefill: Date.now(),
    windowMs,
    maxMessages,
  };
}

/**
 * Check if the rate limit state has expired
 *
 * @param state - Rate limit state to check
 * @param now - Current timestamp in milliseconds
 * @returns True if the state has expired (elapsed time > windowMs)
 */
export function isStateExpired(state: RateLimitState, now: number): boolean {
  // If state hasn't been touched for longer than the window, it's expired
  // (meaning the bucket is full anyway, and we can probably let the key expire in storage)
  return now - state.lastRefill > state.windowMs;
}

/**
 * Generate a rate limit key based on tracking mode and rule ID
 *
 * @param ruleId - Unique identifier for the rate limit rule
 * @param userId - User ID
 * @param documentId - Document ID (optional)
 * @param trackBy - Tracking mode ("user", "document", "user-document")
 * @returns Rate limit key or null if required data is missing
 */
export function getRateLimitKey(
  ruleId: string,
  userId: string | undefined,
  documentId: string | undefined,
  trackBy:
    | "user"
    | "document"
    | "user-document"
    | "transport"
    | string = "transport",
): string | null {
  if (trackBy === "transport") {
    return null;
  }

  if (trackBy === "user") {
    return userId ? `rate-limit:${ruleId}:user:${userId}` : null;
  }

  if (trackBy === "document") {
    return documentId ? `rate-limit:${ruleId}:doc:${documentId}` : null;
  }

  if (trackBy === "user-document") {
    return userId && documentId
      ? `rate-limit:${ruleId}:user-doc:${userId}:${documentId}`
      : null;
  }

  return null;
}
