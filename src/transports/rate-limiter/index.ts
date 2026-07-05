import type { Message, ServerContext, Transport } from "teleportal";
import { AckMessage, RpcMessage } from "teleportal/protocol";
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

/**
 * When at least one whole token will be available again. A token bucket
 * refills continuously (maxMessages per windowMs), so a nacked sender only
 * needs to wait the fractional remainder of ONE token — not for the bucket to
 * fill back to maxMessages. Reporting the latter made retryAfter overshoot by
 * up to a full window (10s for the default per-document rule), which clients
 * experience as a multi-second ack stall on every rate-limit hit.
 */
function nextTokenAvailableAt(
  tokens: number,
  limits: { windowMs: number; maxMessages: number },
  now: number,
): number {
  const msPerToken = limits.windowMs / Math.max(1, limits.maxMessages);
  const tokensNeeded = Math.max(0, 1 - tokens);
  return now + Math.ceil(tokensNeeded * msPerToken);
}

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

/**
 * A message was HELD by flow control (and then delivered) — the healthy
 * signal that rate limiting engaged without losing anything. Distinct from
 * {@link RateLimitExceededData}, which means the message was dropped.
 */
export interface RateLimitDelayedData<Context extends ServerContext = ServerContext> {
  ruleId: string;
  userId?: string;
  documentId?: string;
  trackBy: string;
  /** Total time this message spent waiting on this rule's bucket. */
  delayMs: number;
  maxMessages: number;
  windowMs: number;
  message: Message<Context>;
}

export interface RateLimitEmitter<Context extends ServerContext = ServerContext> {
  call(event: "rate-limit-exceeded", data: RateLimitExceededData<Context>): void;
  call(event: "rate-limit-delayed", data: RateLimitDelayedData<Context>): void;
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
   * Maximum time (ms) to HOLD a rate-limited inbound message while waiting
   * for its bucket to refill, before giving up and dropping it (with a nack
   * via `onRateLimitDrop`). Holding is the primary flow-control mechanism:
   * the per-connection source is consumed sequentially, so a held message
   * naturally slows that client down without losing anything — whereas a
   * dropped doc update engages the client's NACK/retransmit path, and the
   * retransmit races the client's fresh sends for every refilled token while
   * the server parks all causally-later updates on the missing one.
   *
   * Set to 0 to drop immediately on an empty bucket (legacy behavior).
   * @default 1000
   */
  maxDelayMs?: number;

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
   * Called after a message was held by flow control and then delivered.
   * Fires once per (message, rule) wait episode with the total time waited.
   * This is the signal to watch when senders feel throttled but nothing is
   * being dropped.
   */
  onRateLimitDelay?: (details: RateLimitDelayedData<Context>) => void;

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
 * Consuming a token either succeeds (with a `refund` to hand the token back
 * if a LATER rule ends up rejecting the message) or reports why it can't.
 */
type ConsumeResult<Context extends ServerContext> =
  | { ok: true; refund: () => void | Promise<void> }
  | { ok: false; exceeded: RateLimitExceededData<Context> };

/**
 * Ceiling on in-memory fallback buckets per transport instance; a transport
 * serves one connection, so real cardinality (its user + docs it touches) is
 * far below this. Oldest-inserted entries are evicted — they resurrect full.
 */
const MAX_TRANSPORT_BUCKETS = 10_000;

/**
 * A transport wrapper that rate limits the INBOUND source using the token
 * bucket algorithm. Supports multiple independent rate limit rules that all
 * must pass. When a bucket is empty the message is HELD until the next token
 * refills (up to `maxDelayMs`) — the per-connection source is sequential, so
 * this slows the sender to the allowed rate without losing anything. Only
 * messages whose wait would exceed the budget are dropped (never thrown, so
 * the stream stays alive); `onRateLimitDrop` lets the server nack the sender
 * so it can retransmit.
 *
 * Outbound writes are passed through untouched — see the constructor for why
 * dropping server-originated messages is never safe.
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
  private maxDelayMs: number;
  private onRateLimitExceeded?: RateLimitOptions<Context>["onRateLimitExceeded"];
  private onRateLimitDelay?: RateLimitOptions<Context>["onRateLimitDelay"];
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
    this.maxDelayMs = options.maxDelayMs ?? 1000;
    this.onRateLimitExceeded = options.onRateLimitExceeded;
    this.onRateLimitDelay = options.onRateLimitDelay;
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
    // Outbound (server → client) writes are deliberately NOT rate limited.
    // Broadcasts, acks, and sync responses are server-originated: silently
    // dropping a single doc update permanently diverges the receiving client,
    // because Y.js parks every causally-later update on the missing
    // dependency until a full state-vector resync. Egress volume is already
    // bounded by ingress limiting — every broadcast originates from a
    // rate-limited inbound message.
    this.write = async (message: Message<Context>) => {
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
   * Get (creating if needed) and refill the in-memory bucket for a key.
   * Used for `trackBy: "transport"` rules and as the per-transport fallback
   * for the other tracking modes when no storage is configured.
   */
  private getTransportBucket(
    bucketKey: string,
    currentMaxMessages: number,
    currentWindowMs: number,
  ): TokenBucket {
    const now = Date.now();
    let bucket = this.transportBuckets.get(bucketKey);
    if (!bucket) {
      if (this.transportBuckets.size >= MAX_TRANSPORT_BUCKETS) {
        const oldest = this.transportBuckets.keys().next().value;
        if (oldest !== undefined) this.transportBuckets.delete(oldest);
      }
      bucket = { tokens: currentMaxMessages, lastRefill: now };
      this.transportBuckets.set(bucketKey, bucket);
      return bucket;
    }
    const newState = refillRateLimitState(
      {
        tokens: bucket.tokens,
        lastRefill: bucket.lastRefill,
        windowMs: currentWindowMs,
        maxMessages: currentMaxMessages,
      },
      now,
    );
    bucket.tokens = newState.tokens;
    bucket.lastRefill = newState.lastRefill;
    return bucket;
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

  private buildExceededData(
    rule: RateLimitRule<Context>,
    message: Message<Context>,
    maxMessages: number,
    windowMs: number,
    tokens: number,
    now: number,
  ): RateLimitExceededData<Context> {
    const getUserId = rule.getUserId ?? this.defaultGetUserId;
    const getDocumentId = rule.getDocumentId ?? this.defaultGetDocumentId;
    return {
      ruleId: rule.id,
      userId: getUserId?.(message),
      documentId: getDocumentId?.(message),
      trackBy: rule.trackBy,
      currentCount: 0,
      maxMessages,
      windowMs,
      resetAt: nextTokenAvailableAt(tokens, { windowMs, maxMessages }, now),
      message,
    };
  }

  private emitRateLimitDelayed(delayedData: RateLimitDelayedData<Context>): void {
    try {
      this.onRateLimitDelay?.(delayedData);
      this.metricsCollector?.recordRateLimitDelayed(
        delayedData.userId ?? "unknown",
        delayedData.documentId,
        delayedData.trackBy,
        delayedData.delayMs,
      );
      this.eventEmitter?.call("rate-limit-delayed", delayedData);
    } catch (err) {
      console.warn("Rate limit observability hook threw:", err);
    }
  }

  private emitRateLimitExceeded(exceededData: RateLimitExceededData<Context>): void {
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
  }

  /**
   * Atomically try to consume one token for a rule. On success the returned
   * `refund` hands the token back — used when a later rule rejects the
   * message, so retransmits of the dropped message don't drain the budgets
   * of the rules it passed.
   */
  private async tryConsumeRule(
    rule: RateLimitRule<Context>,
    message: Message<Context>,
  ): Promise<ConsumeResult<Context>> {
    if (rule.shouldSkipRule) {
      if (await rule.shouldSkipRule(message)) return { ok: true, refund: () => {} };
    }
    const currentMaxMessages = await this.resolveLimit(rule.maxMessages, message);
    const currentWindowMs = await this.resolveLimit(rule.windowMs, message);
    const storage = rule.rateLimitStorage ?? this.defaultRateLimitStorage;
    const key = this.getRateLimitKey(rule.id, rule, message);

    if (storage && key) {
      return storage.transaction(key, async (): Promise<ConsumeResult<Context>> => {
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
        if (state.tokens < 1) {
          return {
            ok: false,
            exceeded: this.buildExceededData(
              rule,
              message,
              currentMaxMessages,
              currentWindowMs,
              state.tokens,
              now,
            ),
          };
        }
        state.tokens -= 1;
        await storage.setState(key, state, currentWindowMs);
        this.metricsCollector?.recordRateLimitStateOperation("set", rule.trackBy);
        this.eventEmitter?.call("rate-limit-state-updated", {
          ruleId: rule.id,
          key,
          tokens: state.tokens,
          trackBy: rule.trackBy,
        });
        return {
          ok: true,
          refund: () =>
            storage.transaction(key, async () => {
              const current = await storage.getState(key);
              if (!current) return;
              current.tokens = Math.min(current.maxMessages, current.tokens + 1);
              await storage.setState(key, current, current.windowMs);
            }),
        };
      });
    }

    // In-memory per-transport fallback: `trackBy: "transport"` rules always
    // land here (keyed by rule id); the other tracking modes land here when
    // no storage is configured or no user/document id could be derived —
    // keyed by the same key a storage backend would use, so limits are still
    // enforced per tracked entity (within this transport instance) instead
    // of silently not at all.
    const bucketKey = key ?? rule.id;
    const bucket = this.getTransportBucket(bucketKey, currentMaxMessages, currentWindowMs);
    if (bucket.tokens < 1) {
      return {
        ok: false,
        exceeded: this.buildExceededData(
          rule,
          message,
          currentMaxMessages,
          currentWindowMs,
          bucket.tokens,
          Date.now(),
        ),
      };
    }
    bucket.tokens -= 1;
    return {
      ok: true,
      refund: () => {
        bucket.tokens = Math.min(currentMaxMessages, bucket.tokens + 1);
      },
    };
  }

  /**
   * Enforce all rules against a message, holding it (bounded by
   * `maxDelayMs`) while empty buckets refill. Returns null once every rule
   * has admitted the message — possibly after a delay, which is the flow
   * control that slows a fast sender to the allowed rate. Returns the
   * exceeded data only when the message must be DROPPED because the wait
   * would blow the delay budget; tokens consumed by rules that already
   * passed are refunded so the sender's retransmit isn't double-charged.
   */
  private async checkRateLimit(
    message: Message<Context>,
  ): Promise<RateLimitExceededData<Context> | null> {
    if (!(await this.shouldRateLimit(message))) return null;
    const deadline = Date.now() + this.maxDelayMs;
    const refunds: Array<() => void | Promise<void>> = [];
    for (const rule of this.rules) {
      let waitedMs = 0;
      let lastRejection: RateLimitExceededData<Context> | null = null;
      for (;;) {
        const result = await this.tryConsumeRule(rule, message);
        if (result.ok) {
          refunds.push(result.refund);
          if (waitedMs > 0 && lastRejection) {
            this.emitRateLimitDelayed({
              ruleId: lastRejection.ruleId,
              userId: lastRejection.userId,
              documentId: lastRejection.documentId,
              trackBy: lastRejection.trackBy,
              delayMs: waitedMs,
              maxMessages: lastRejection.maxMessages,
              windowMs: lastRejection.windowMs,
              message,
            });
          }
          break;
        }
        const waitMs = Math.max(1, result.exceeded.resetAt - Date.now());
        if (Date.now() + waitMs > deadline) {
          for (const refund of refunds) {
            try {
              await refund();
            } catch {
              // A failed refund only under-admits; never block the drop path.
            }
          }
          this.emitRateLimitExceeded(result.exceeded);
          return result.exceeded;
        }
        // Wait for the next token OUTSIDE any storage transaction, then
        // re-attempt (another sender may have raced us to the token).
        lastRejection = result.exceeded;
        waitedMs += waitMs;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
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
      // Drop (never throw): a throw here rejects the async iterable, which
      // tears down the server's per-client consume loop — the connection then
      // stops acking and broadcasting while the socket stays open. Nack with
      // a reason (no retryAfter — retransmitting the same message would fail
      // again) so the sender stops waiting for an ack and can surface the
      // rejection.
      if (!this.checkMessageSize(msg)) {
        const size = msg.encoded?.byteLength ?? 0;
        Promise.resolve(
          write(
            new AckMessage({
              type: "ack",
              messageId: msg.id,
              error: `message-too-large: ${size} > ${this.maxMessageSize} bytes`,
            }) as unknown as Message<Context>,
          ),
        ).catch(() => {});
        return null;
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
 * Returns true for ephemeral metadata messages (cursor/selection awareness,
 * presence). These fire per keystroke UNBATCHED, so a fast typist emits
 * dozens per second — counting them against the sync budgets lets cursor
 * chatter drain the budget that doc updates need, stalling actual content
 * propagation. They get their own budget instead: dropping one is harmless
 * (the next update supersedes it) and they are never retransmitted.
 */
export function isEphemeralMetadataMessage(message: Message<any>): boolean {
  return message.type === "awareness" || message.type === "presence";
}

/**
 * Default rate limit rules with separate budgets for sync messages,
 * ephemeral metadata (awareness/presence), and file transfers.
 *
 * - Sync: 300 msgs/s per user, 1500 msgs/10s per document
 * - Awareness/presence: 120 msgs/s per user
 * - File transfers: 5000 chunks/s per user
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
      shouldSkipRule: (msg) => isFileTransferMessage(msg) || isEphemeralMetadataMessage(msg),
    },
    {
      id: "sync-per-document",
      maxMessages: 1500,
      windowMs: 10_000,
      trackBy: "document",
      shouldSkipRule: (msg) => isFileTransferMessage(msg) || isEphemeralMetadataMessage(msg),
    },
    {
      id: "awareness-per-user",
      maxMessages: 120,
      windowMs: 1000,
      trackBy: "user",
      shouldSkipRule: (msg) => !isEphemeralMetadataMessage(msg),
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
