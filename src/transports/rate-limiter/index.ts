import type { Message, ServerContext, Transport } from "teleportal";
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
  call(
    event: "rate-limit-exceeded",
    data: RateLimitExceededData<Context>,
  ): void;
  call(
    event: "rate-limit-state-updated",
    data: RateLimitStateUpdatedData,
  ): void;
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
  shouldSkipRateLimit?: (
    message: Message<Context>,
  ) => Promise<boolean> | boolean;

  /**
   * Called when permission is denied
   */
  onPermissionDenied?: (message: Message<Context>) => void;

  /**
   * Called when rate limit is exceeded
   */
  onRateLimitExceeded?: (
    details: RateLimitExceededData<Context>,
  ) => void;

  /**
   * Called when message size limit is exceeded
   */
  onMessageSizeExceeded?: (details: {
    size: number;
    maxSize: number;
    message: Message<Context>;
  }) => void;

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
  public readable: ReadableStream<Message<Context>>;
  public writable: WritableStream<Message<Context>>;

  private rules: RateLimitRule<Context>[];
  private maxMessageSize: number;
  private onRateLimitExceeded?: RateLimitOptions<Context>["onRateLimitExceeded"];
  private onMessageSizeExceeded?: RateLimitOptions<Context>["onMessageSizeExceeded"];
  private onPermissionDenied?: RateLimitOptions<Context>["onPermissionDenied"];
  private metricsCollector?: MetricsCollector;
  private eventEmitter?: RateLimitEmitter<Context>;

  private defaultRateLimitStorage?: RateLimitStorage;
  private defaultGetUserId?: (message: Message<Context>) => string | undefined;
  private defaultGetDocumentId?: (
    message: Message<Context>,
  ) => string | undefined;
  private checkPermission?: (
    message: Message<Context>,
  ) => Promise<boolean> | boolean;
  private shouldSkipRateLimitFunc?: (
    message: Message<Context>,
  ) => Promise<boolean> | boolean;

  // In-memory buckets for transport-level tracking (one per rule)
  private transportBuckets: Map<string, TokenBucket> = new Map();

  constructor(
    transport: Transport<Context, AdditionalProps>,
    options: RateLimitOptions<Context>,
  ) {
    if (!options.rules || options.rules.length === 0) {
      throw new Error("At least one rate limit rule is required");
    }

    this.rules = options.rules;
    this.maxMessageSize = options.maxMessageSize ?? 1024 * 1024 * 10; // 10MB default
    this.onRateLimitExceeded = options.onRateLimitExceeded;
    this.onMessageSizeExceeded = options.onMessageSizeExceeded;
    this.onPermissionDenied = options.onPermissionDenied;
    this.metricsCollector = options.metricsCollector;
    this.eventEmitter = options.eventEmitter;

    this.defaultRateLimitStorage = options.rateLimitStorage;
    this.defaultGetUserId = options.getUserId ?? ((msg) => msg.context?.userId);
    this.defaultGetDocumentId =
      options.getDocumentId ?? ((msg) => msg.document);
    this.checkPermission = options.checkPermission;
    this.shouldSkipRateLimitFunc = options.shouldSkipRateLimit;

    // Initialize transport streams with rate limiting
    this.readable = this.createRateLimitedReadable(transport.readable);
    this.writable = this.createRateLimitedWritable(transport.writable);
  }

  private async resolveLimit(
    resolver: LimitResolver<Context>,
    message: Message<Context>,
  ): Promise<number> {
    if (typeof resolver === "number") {
      return resolver;
    }
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
      this.transportBuckets.set(ruleId, {
        tokens: currentMaxMessages,
        lastRefill: now,
      });
      return;
    }

    const state = {
      tokens: bucket.tokens,
      lastRefill: bucket.lastRefill,
      windowMs: currentWindowMs,
      maxMessages: currentMaxMessages,
    };

    const newState = refillRateLimitState(state, now);

    this.transportBuckets.set(ruleId, {
      tokens: newState.tokens,
      lastRefill: newState.lastRefill,
    });
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
    const userId = getUserId?.(message);
    const documentId = getDocumentId?.(message);

    return getRateLimitKey(ruleId, userId, documentId, rule.trackBy);
  }

  /**
   * Check if rate limiting should be applied to this message
   * Returns true if rate limit check should proceed
   * Returns false if message should be allowed (e.g. permission denied handled elsewhere)
   */
  private async shouldRateLimit(message: Message<Context>): Promise<boolean> {
    if (this.shouldSkipRateLimitFunc) {
      if (await this.shouldSkipRateLimitFunc(message)) {
        return false;
      }
    }

    if (this.checkPermission) {
      const hasPermission = await this.checkPermission(message);
      if (!hasPermission) {
        // Permission denied, so we skip rate limiting
        // The permission system (elsewhere) should reject this message
        // But we want to avoid consuming tokens for invalid messages
        this.onPermissionDenied?.(message);
        return false;
      }
    }
    return true;
  }

  /**
   * Check a single rate limit rule
   */
  private async checkRule(
    rule: RateLimitRule<Context>,
    message: Message<Context>,
  ): Promise<boolean> {
    // Skip this rule if shouldSkipRule returns true
    if (rule.shouldSkipRule) {
      if (await rule.shouldSkipRule(message)) {
        return true;
      }
    }

    // Resolve dynamic limits
    const currentMaxMessages = await this.resolveLimit(
      rule.maxMessages,
      message,
    );
    const currentWindowMs = await this.resolveLimit(rule.windowMs, message);

    // Get storage for this rule (rule-specific or default)
    const storage = rule.rateLimitStorage ?? this.defaultRateLimitStorage;
    const key = this.getRateLimitKey(rule.id, rule, message);

    // If persistent storage is configured and we have a key, use it
    if (storage && key) {
      // Use transaction to ensure atomicity
      return storage.transaction(key, async () => {
        const now = Date.now();
        let state = await storage.getState(key);
        this.metricsCollector?.recordRateLimitStateOperation(
          "get",
          rule.trackBy,
        );

        if (!state) {
          state = createInitialState(currentWindowMs, currentMaxMessages);
        } else {
          // Update state with potentially new limits to ensure correct refill calculation
          state.maxMessages = currentMaxMessages;
          state.windowMs = currentWindowMs;
          state = refillRateLimitState(state, now);
        }

        if (state.tokens < 1) {
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
            resetAt: state.lastRefill + state.windowMs,
            message,
          };
          this.onRateLimitExceeded?.(exceededData);
          this.metricsCollector?.recordRateLimitExceeded(
            exceededData.userId ?? "unknown",
            exceededData.documentId,
            exceededData.trackBy,
          );
          this.eventEmitter?.call("rate-limit-exceeded", exceededData);
          return false;
        }

        // Consume token
        state.tokens -= 1;

        await storage.setState(key, state, currentWindowMs);
        this.metricsCollector?.recordRateLimitStateOperation(
          "set",
          rule.trackBy,
        );
        this.eventEmitter?.call("rate-limit-state-updated", {
          ruleId: rule.id,
          key,
          tokens: state.tokens,
          trackBy: rule.trackBy,
        });

        return true;
      });
    }

    // Fallback to in-memory transport-level tracking
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
        this.onRateLimitExceeded?.(exceededData);
        this.metricsCollector?.recordRateLimitExceeded(
          "unknown",
          undefined,
          "transport",
        );
        this.eventEmitter?.call("rate-limit-exceeded", exceededData);
        return false;
      }

      bucket.tokens--;
      return true;
    }

    // If we don't have storage and it's not transport-level, we can't track it
    // This shouldn't happen in practice, but fail open for safety
    return true;
  }

  /**
   * Check if a message can be sent based on all rate limit rules
   * All rules must pass for the message to be allowed
   */
  private async checkRateLimit(message: Message<Context>): Promise<boolean> {
    // 1. Check global permissions first
    if (!(await this.shouldRateLimit(message))) {
      return true;
    }

    // 2. Check all rules sequentially
    // If any rule fails, reject immediately
    for (const rule of this.rules) {
      const passed = await this.checkRule(rule, message);
      if (!passed) {
        return false;
      }
    }

    return true;
  }

  /**
   * Check if a message size is within limits
   */
  private checkMessageSize(message: Message<Context>): boolean {
    const size = new TextEncoder().encode(JSON.stringify(message)).length;
    if (size > this.maxMessageSize) {
      this.onMessageSizeExceeded?.({
        size,
        maxSize: this.maxMessageSize,
        message,
      });
      return false;
    }
    return true;
  }

  /**
   * Create a rate-limited writable stream
   */
  private createRateLimitedWritable(
    writable: WritableStream<Message<Context>>,
  ): WritableStream<Message<Context>> {
    const writer = writable.getWriter();

    return new WritableStream<Message<Context>>({
      write: async (chunk) => {
        if (!this.checkMessageSize(chunk)) {
          throw new Error("Message size limit exceeded");
        }

        if (!(await this.checkRateLimit(chunk))) {
          throw new Error("Rate limit exceeded");
        }

        return writer.write(chunk);
      },
      close: () => writer.close(),
      abort: (reason) => writer.abort(reason),
    });
  }

  /**
   * Create a rate-limited readable stream
   */
  private createRateLimitedReadable(
    readable: ReadableStream<Message<Context>>,
  ): ReadableStream<Message<Context>> {
    return readable.pipeThrough(
      new TransformStream<Message<Context>, Message<Context>>({
        transform: async (chunk, controller) => {
          if (!this.checkMessageSize(chunk)) {
            throw new Error("Message size limit exceeded");
          }

          if (!(await this.checkRateLimit(chunk))) {
            throw new Error("Rate limit exceeded");
          }

          controller.enqueue(chunk);
        },
      }),
    );
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
    readable: rateLimited.readable,
    writable: rateLimited.writable,
  };
}
