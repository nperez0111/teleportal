import { describe, expect, it } from "bun:test";
import {
  calculateTokensToAdd,
  createInitialState,
  getRateLimitKey,
  isStateExpired,
  refillRateLimitState,
} from "./rate-limit-utils";
import type { RateLimitState } from "./types";

describe("rate-limit-utils", () => {
  describe("calculateTokensToAdd", () => {
    it("should calculate correct tokens for elapsed time", () => {
      // 1000ms window, 10 messages max
      // 500ms elapsed -> 5 tokens
      expect(calculateTokensToAdd(500, 1000, 10)).toBe(5);

      // 100ms elapsed -> 1 token
      expect(calculateTokensToAdd(100, 1000, 10)).toBe(1);

      // 2000ms elapsed -> 20 tokens
      expect(calculateTokensToAdd(2000, 1000, 10)).toBe(20);
    });

    it("should return 0 for negative elapsed time", () => {
      expect(calculateTokensToAdd(-100, 1000, 10)).toBe(0);
    });

    it("should return maxMessages for 0 windowMs", () => {
      expect(calculateTokensToAdd(100, 0, 10)).toBe(10);
    });
  });

  describe("createInitialState", () => {
    it("should create correct initial state", () => {
      const state = createInitialState(1000, 10);
      expect(state.tokens).toBe(10);
      expect(state.windowMs).toBe(1000);
      expect(state.maxMessages).toBe(10);
      expect(state.lastRefill).toBeLessThanOrEqual(Date.now());
    });
  });

  describe("refillRateLimitState", () => {
    it("should refill tokens correctly", () => {
      const now = 10000;
      const state: RateLimitState = {
        tokens: 5,
        lastRefill: now - 500, // 500ms ago
        windowMs: 1000,
        maxMessages: 10,
      };

      // 500ms elapsed = 5 tokens added. 5 + 5 = 10 tokens
      const newState = refillRateLimitState(state, now);
      expect(newState.tokens).toBe(10);
      expect(newState.lastRefill).toBe(now);
    });

    it("should cap tokens at maxMessages", () => {
      const now = 10000;
      const state: RateLimitState = {
        tokens: 8,
        lastRefill: now - 500, // 500ms ago
        windowMs: 1000,
        maxMessages: 10,
      };

      // 500ms elapsed = 5 tokens added. 8 + 5 = 13 -> capped at 10
      const newState = refillRateLimitState(state, now);
      expect(newState.tokens).toBe(10);
      expect(newState.lastRefill).toBe(now);
    });

    it("should not change state if elapsed is 0 or negative", () => {
      const now = 10000;
      const state: RateLimitState = {
        tokens: 5,
        lastRefill: now,
        windowMs: 1000,
        maxMessages: 10,
      };

      const newState = refillRateLimitState(state, now);
      expect(newState).toEqual(state);
    });
  });

  describe("isStateExpired", () => {
    it("should return true if state is older than windowMs", () => {
      const now = 10000;
      const state: RateLimitState = {
        tokens: 10,
        lastRefill: now - 2000, // 2000ms ago
        windowMs: 1000,
        maxMessages: 10,
      };

      expect(isStateExpired(state, now)).toBe(true);
    });

    it("should return false if state is within windowMs", () => {
      const now = 10000;
      const state: RateLimitState = {
        tokens: 10,
        lastRefill: now - 500, // 500ms ago
        windowMs: 1000,
        maxMessages: 10,
      };

      expect(isStateExpired(state, now)).toBe(false);
    });
  });

  describe("getRateLimitKey", () => {
    it("should return null for transport tracking", () => {
      expect(getRateLimitKey("rule1", "user1", "doc1", "transport")).toBe(null);
    });

    it("should return user key with rule ID", () => {
      expect(getRateLimitKey("rule1", "user1", undefined, "user")).toBe(
        "rate-limit:rule1:user:user1",
      );
    });

    it("should return null for user tracking if userId missing", () => {
      expect(getRateLimitKey("rule1", undefined, undefined, "user")).toBe(null);
    });

    it("should return document key with rule ID", () => {
      expect(getRateLimitKey("rule1", undefined, "doc1", "document")).toBe(
        "rate-limit:rule1:doc:doc1",
      );
    });

    it("should return null for document tracking if documentId missing", () => {
      expect(getRateLimitKey("rule1", undefined, undefined, "document")).toBe(null);
    });

    it("should return user-document key with rule ID", () => {
      expect(getRateLimitKey("rule1", "user1", "doc1", "user-document")).toBe(
        "rate-limit:rule1:user-doc:user1:doc1",
      );
    });

    it("should return null for user-document tracking if either missing", () => {
      expect(getRateLimitKey("rule1", "user1", undefined, "user-document")).toBe(null);
      expect(getRateLimitKey("rule1", undefined, "doc1", "user-document")).toBe(null);
    });
  });
});
