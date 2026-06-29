import type { Message, ServerContext, Transport } from "teleportal";
import { RpcMessage } from "teleportal/protocol";
import { mapMessages } from "../utils";
import type { MetricsCollector } from "../../monitoring";
import {
  createInitialState,
  getRateLimitKey,
  refillRateLimitState,
} from "../../storage/rate-limit-utils";
import type { RateLimitStorage } from "../../storage/types";

export type LimitResolver<Context extends ServerContext> =
  | number
  | ((message: Message<Context>) => number | Promise<number>);

export interface RateLimitExceededData<Context extends ServerContext = ServerContext> {
  ruleId: string;
  userId?: string;
  documentId?: string;
  trackBy: string;
  currentCount: number;
  maxMessages: number;
  windowMs: number;
  resetAt: number;
  message: Message<Context>;
}

export interface RateLimitStateUpdatedData {
  ruleId: string;
  key: string;
  tokens: number;
  trackBy: string;
}

export interface RateLimitEmitter<Context extends ServerContext = ServerContext> {
  call(event: "rate-limit-exceeded", data: RateLimitExceededData<Context>): void;
  call(event: "rate-limit-state-updated", data: RateLimitStateUpdatedData): void;
}

/**
 * A single rate limit rule that defines limits for a specific tracking dimension
 */
export interface RateLimitRule<Context extends ServerContext> {
  /**
   * Unique identifier for this rule (used in storage keys, metrics, and events)
   */
  id: string;

  /**
   * Maximum number of messages per window for this rule.
   * Can be a number or a function that returns the limit based on the message.
   */
  maxMessages: LimitResolver<Context>;

  /**
   * Time window in milliseconds for this rule.
   * Can be a number or a function that returns the window based on the message.
   */
  windowMs: LimitResolver<Context>;

  /**
   * How to track rate limits for this rule.
   * - "transport": Per transport instance (in-memory only)
   * - "user": Per user ID
   * - "document": Per document ID
   * - "user-document": Per user ID and document ID pair
   */
  trackBy: "user" | "document" | "user-document" | "transport";

  /**
   * Optional: Override storage backend for this specific rule.
   * If not provided, uses the global rateLimitStorage from options.
   */
  rateLimitStorage?: RateLimitStorage;

  /**
   * Optional: Override function to extract user ID from message for this rule.
   * If not provided, uses the global getUserId from options.
   */
  getUserId?: (message: Message<Context>) => string | undefined;

  /**
   * Optional: Override function to extract document ID from message for this rule.
   * If not provided, uses the global getDocumentId from options.
   */
  getDocumentId?: (message: Message<Context>) => string | undefined;

  /**
   * Optional: Skip this specific rule for certain messages.
   * If returns true, this rule is skipped (not checked) and no tokens are consumed.
   */
  shouldSkipRule?: (message: Message<Context>) => Promise<boolean> | boolean;
}

export interface RateLimitOptions<Context extends ServerContext> {
  /**
   * Array of rate limit rules to enforce.
   * All rules must pass for a message to be allowed.
   */
  rules: RateLimitRule<Context>[];

  /**
   * Maximum message size in bytes
   * @default 10MB
   */
  maxMessageSize?: number;

  /**
   * Default storage backend for rate limit state.
   * Individual rules can override this with their own rateLimitStorage.
   * If not provided, rate limits will be in-memory per transport instance.
   */
  rateLimitStorage?: RateLimitStorage;

  /**
   * Default function to extract user ID from message.
   * Individual rules can override this with their own getUserId.
   */
  getUserId?: (message: Message<Context>) => string | undefined;

  /**
   * Default function to extract document ID from message.
   * Individual rules can override this with their own getDocumentId.
   */
  getDocumentId?: (message: Message<Context>) => string | undefined;

  /**
   * Function to check if message should be allowed regardless of rate limit.
   * Can be used to implement permission-based rate limiting.
   * If returns false, rate limit is skipped (message allowed).
   */
  checkPermission?: (message: Message<Context>) => Promise<boolean> | boolean;

  /**
   * Function to check if rate limiting should be skipped for this message.
   * If returns true, all rate limit rules are skipped (message allowed) and no tokens are consumed.
   * Useful for admin users or allow-listed sources.
   */
  shouldSkipRateLimit?: (message: Message<Context>) => Promise<boolean> | boolean;

  /**
   * Called when permission is denied
   */
  onPermissionDenied?: (message: Message<Context>) => void;

  /**
   * Called when rate limit is exceeded
   */
  onRateLimitExceeded?: (details: RateLimitExceededData<Context>) => void;

  /**
   * Called when message size limit is exceeded
   */
  onMessageSizeExceeded?: (details: {
    size: number;
    maxSize: number;
    message: Message<Context>;
  }) => void;

  /**
   * Called when an incoming message is dropped due to rate limiting.
   * Use this to send a nack/response back to the client so it can back off.
   */
  onRateLimitDrop?: (
    message: Message<Context>,
    exceeded: RateLimitExceededData<Context>,
    write: (msg: Message<Context>) => void | Promise<void>,
  ) => void;

  /**
   * Metrics collector for recording rate limit metrics
   */
  metricsCollector?: MetricsCollector;

  /**
   * Event emitter for rate limit events
   */
  eventEmitter?: RateLimitEmitter<Context>;
}

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

/**
 * A transport wrapper that implements rate limiting using the token bucket algorithm
 * Supports multiple independent rate limit rules that all must pass
 */
export class RateLimitedTransport<
  Context extends ServerContext,
  AdditionalProps extends Record<string, unknown>,
> {
  public source: AsyncIterable<Message<Context>[]>;
  public write: (message: Message<Context>) => Promise<void>;
  public close: () => void;

  private rules: RateLimitRule<Context>[];
  private maxMessageSize: number;
  private onRateLimitExceeded?: RateLimitOptions<Context>["onRateLimitExceeded"];
  private onMessageSizeExceeded?: RateLimitOptions<Context>["onMessageSizeExceeded"];
  private onPermissionDenied?: RateLimitOptions<Context>["onPermissionDenied"];
  private onRateLimitDrop?: RateLimitOptions<Context>["onRateLimitDrop"];
  private metricsCollector?: MetricsCollector;
  private eventEmitter?: RateLimitEmitter<Context>;

  private defaultRateLimitStorage?: RateLimitStorage;
  private defaultGetUserId?: (message: Message<Context>) => string | undefined;
  private defaultGetDocumentId?: (message: Message<Context>) => string | undefined;
  private checkPermission?: (message: Message<Context>) => Promise<boolean> | boolean;
  private shouldSkipRateLimitFunc?: (message: Message<Context>) => Promise<boolean> | boolean;

  private transportBuckets: Map<string, TokenBucket> = new Map();

  constructor(transport: Transport<Context, AdditionalProps>, options: RateLimitOptions<Context>) {
    if (!options.rules || options.rules.length === 0) {
      throw new Error("At least one rate limit rule is required");
    }

    this.rules = options.rules;
    this.maxMessageSize = options.maxMessageSize ?? 1024 * 1024 * 10;
    this.onRateLimitExceeded = options.onRateLimitExceeded;
    this.onMessageSizeExceeded = options.onMessageSizeExceeded;
    this.onPermissionDenied = options.onPermissionDenied;
    this.onRateLimitDrop = options.onRateLimitDrop;
    this.metricsCollector = options.metricsCollector;
    this.eventEmitter = options.eventEmitter;

    this.defaultRateLimitStorage = options.rateLimitStorage;
    this.defaultGetUserId = options.getUserId ?? ((msg) => msg.context?.userId);
    this.defaultGetDocumentId = options.getDocumentId ?? ((msg) => msg.document);
    this.checkPermission = options.checkPermission;
    this.shouldSkipRateLimitFunc = options.shouldSkipRateLimit;

    const originalWrite = transport.write.bind(transport);
    this.source = this.createRateLimitedSource(transport.source, originalWrite);
    const originalClose = transport.close.bind(transport);
    this.write = async (message: Message<Context>) => {
      if (!this.checkMessageSize(message)) {
        throw new Error("Message size limit exceeded");
      }
      const exceeded = await this.checkRateLimit(message);
      if (exceeded) {
        return;
      }
      await originalWrite(message);
    };
    this.close = originalClose;
  }

  private async resolveLimit(
    resolver: LimitResolver<Context>,
    message: Message<Context>,
  ): Promise<number> {
    if (typeof resolver === "number") return resolver;
    return await resolver(message);
  }

  /**
   * Refill the in-memory bucket for a specific rule based on elapsed time
   */
  private refillTransportBucket(
    ruleId: string,
    currentMaxMessages: number,
    currentWindowMs: number,
  ) {
    const now = Date.now();
    const bucket = this.transportBuckets.get(ruleId);
    if (!bucket) {
      this.transportBuckets.set(ruleId, { tokens: currentMaxMessages, lastRefill: now });
      return;
    }
    const state = {
      tokens: bucket.tokens,
      lastRefill: bucket.lastRefill,
      windowMs: currentWindowMs,
      maxMessages: currentMaxMessages,
    };
    const newState = refillRateLimitState(state, now);
    this.transportBuckets.set(ruleId, { tokens: newState.tokens, lastRefill: newState.lastRefill });
  }

  /**
   * Get the rate limit key for a message and rule
   */
  private getRateLimitKey(
    ruleId: string,
    rule: RateLimitRule<Context>,
    message: Message<Context>,
  ): string | null {
    const getUserId = rule.getUserId ?? this.defaultGetUserId;
    const getDocumentId = rule.getDocumentId ?? this.defaultGetDocumentId;
    return getRateLimitKey(ruleId, getUserId?.(message), getDocumentId?.(message), rule.trackBy);
  }

  /**
   * Check if rate limiting should be applied to this message
   * Returns true if rate limit check should proceed
   * Returns false if message should be allowed (e.g. permission denied handled elsewhere)
   */
  private async shouldRateLimit(message: Message<Context>): Promise<boolean> {
    if (this.shouldSkipRateLimitFunc) {
      if (await this.shouldSkipRateLimitFunc(message)) return false;
    }
    if (this.checkPermission) {
      const hasPermission = await this.checkPermission(message);
      if (!hasPermission) {
        this.onPermissionDenied?.(message);
        return false;
      }
    }
    return true;
  }

  /**
   * Check a single rate limit rule.
   * Returns null if the rule passes, or the exceeded data if violated.
   */
  private async checkRule(
    rule: RateLimitRule<Context>,
    message: Message<Context>,
  ): Promise<RateLimitExceededData<Context> | null> {
    if (rule.shouldSkipRule) {
      if (await rule.shouldSkipRule(message)) return null;
    }
    const currentMaxMessages = await this.resolveLimit(rule.maxMessages, message);
    const currentWindowMs = await this.resolveLimit(rule.windowMs, message);
    const storage = rule.rateLimitStorage ?? this.defaultRateLimitStorage;
    const key = this.getRateLimitKey(rule.id, rule, message);

    if (storage && key) {
      return storage.transaction(key, async () => {
        const now = Date.now();
        let state = await storage.getState(key);
        this.metricsCollector?.recordRateLimitStateOperation("get", rule.trackBy);
        if (!state) {
          state = createInitialState(currentWindowMs, currentMaxMessages);
        } else {
          state.maxMessages = currentMaxMessages;
          state.windowMs = currentWindowMs;
          state = refillRateLimitState(state, now);
        }
        const currentState = state;
        if (currentState.tokens < 1) {
          const getUserId = rule.getUserId ?? this.defaultGetUserId;
          const getDocumentId = rule.getDocumentId ?? this.defaultGetDocumentId;
          const exceededData: RateLimitExceededData<Context> = {
            ruleId: rule.id,
            userId: getUserId?.(message),
            documentId: getDocumentId?.(message),
            trackBy: rule.trackBy,
            currentCount: 0,
            maxMessages: currentMaxMessages,
            windowMs: currentWindowMs,
            resetAt: currentState.lastRefill + currentState.windowMs,
            message,
          };
          try {
            this.onRateLimitExceeded?.(exceededData);
            this.metricsCollector?.recordRateLimitExceeded(
              exceededData.userId ?? "unknown",
              exceededData.documentId,
              exceededData.trackBy,
            );
            this.eventEmitter?.call("rate-limit-exceeded", exceededData);
          } catch (err) {
            console.warn("Rate limit observability hook threw:", err);
          }
          return exceededData;
        }
        currentState.tokens -= 1;
        await storage.setState(key, currentState, currentWindowMs);
        this.metricsCollector?.recordRateLimitStateOperation("set", rule.trackBy);
        this.eventEmitter?.call("rate-limit-state-updated", {
          ruleId: rule.id,
          key,
          tokens: currentState.tokens,
          trackBy: rule.trackBy,
        });
        return null;
      });
    }

    if (rule.trackBy === "transport") {
      this.refillTransportBucket(rule.id, currentMaxMessages, currentWindowMs);
      const bucket = this.transportBuckets.get(rule.id)!;
      if (bucket.tokens < 1) {
        const exceededData: RateLimitExceededData<Context> = {
          ruleId: rule.id,
          trackBy: "transport",
          currentCount: 0,
          maxMessages: currentMaxMessages,
          windowMs: currentWindowMs,
          resetAt: bucket.lastRefill + currentWindowMs,
          message,
        };
        try {
          this.onRateLimitExceeded?.(exceededData);
          this.metricsCollector?.recordRateLimitExceeded("unknown", undefined, "transport");
          this.eventEmitter?.call("rate-limit-exceeded", exceededData);
        } catch (err) {
          console.warn("Rate limit observability hook threw:", err);
        }
        return exceededData;
      }
      bucket.tokens--;
      return null;
    }

    return null;
  }

  /**
   * Check if a message can be sent based on all rate limit rules
   * All rules must pass for the message to be allowed.
   * Returns null if allowed, or the exceeded data if rejected.
   */
  private async checkRateLimit(
    message: Message<Context>,
  ): Promise<RateLimitExceededData<Context> | null> {
    if (!(await this.shouldRateLimit(message))) return null;
    for (const rule of this.rules) {
      const exceeded = await this.checkRule(rule, message);
      if (exceeded) return exceeded;
    }
    return null;
  }

  /**
   * Check if a message size is within limits
   */
  private checkMessageSize(message: Message<Context>): boolean {
    const encoded = message.encoded;
    const size = encoded ? encoded.byteLength : 0;
    if (size > this.maxMessageSize) {
      this.onMessageSizeExceeded?.({ size, maxSize: this.maxMessageSize, message });
      return false;
    }
    return true;
  }

  /**
   * Create a rate-limited source iterable.
   * Rate-limited messages are silently dropped (never thrown) to keep the stream alive.
   */
  private createRateLimitedSource(
    source: AsyncIterable<Message<Context>[]>,
    write: (msg: Message<Context>) => void | Promise<void>,
  ): AsyncIterable<Message<Context>[]> {
    return mapMessages(async (msg: Message<Context>) => {
      // Skip expensive size check for RPC stream messages — encoding
      // the already-decoded 64KB+ payload just to measure its length
      // is wasteful. Stream messages are bounded by the chunk size.
      if (!isFileTransferMessage(msg) && !this.checkMessageSize(msg)) {
        throw new Error("Message size limit exceeded");
      }
      const exceeded = await this.checkRateLimit(msg);
      if (exceeded) {
        if (this.onRateLimitDrop) {
          try {
            this.onRateLimitDrop(msg, exceeded, write);
          } catch {
            // Swallow errors from the drop callback
          }
        }
        return null;
      }
      return msg;
    })(source);
  }
}

/**
 * Create a rate-limited transport wrapper
 */
export function withRateLimit<
  Context extends ServerContext,
  AdditionalProps extends Record<string, unknown>,
>(
  transport: Transport<Context, AdditionalProps>,
  options: RateLimitOptions<Context>,
): Transport<Context, AdditionalProps> {
  const rateLimited = new RateLimitedTransport(transport, options);
  return {
    ...transport,
    source: rateLimited.source,
    write: rateLimited.write,
    close: rateLimited.close,
  };
}

/**
 * Returns true if the message is a file transfer chunk (upload or download stream).
 */
export function isFileTransferMessage(message: Message<any>): boolean {
  return (
    message instanceof RpcMessage &&
    (message.rpcMethod === "fileUpload" || message.rpcMethod === "fileDownload") &&
    message.requestType === "stream"
  );
}

/**
 * Default rate limit rules with separate budgets for sync messages and file transfers.
 *
 * - Sync: 300 msgs/s per user, 1500 msgs/10s per document
 * - File transfers: 5000 chunks/s per user (≈ 320 MB/s at 64KB chunks)
 *
 * File initiation requests (non-stream RPC) count toward the sync budget.
 */
export function defaultRateLimitRules<Context extends ServerContext>(): RateLimitRule<Context>[] {
  return [
    {
      id: "sync-per-user",
      maxMessages: 300,
      windowMs: 1000,
      trackBy: "user",
      shouldSkipRule: (msg) => isFileTransferMessage(msg),
    },
    {
      id: "sync-per-document",
      maxMessages: 1500,
      windowMs: 10_000,
      trackBy: "document",
      shouldSkipRule: (msg) => isFileTransferMessage(msg),
    },
    {
      id: "file-transfer-per-user",
      maxMessages: 5000,
      windowMs: 1000,
      trackBy: "user",
      shouldSkipRule: (msg) => !isFileTransferMessage(msg),
    },
  ];
}
