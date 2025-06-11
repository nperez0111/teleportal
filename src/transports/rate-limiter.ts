import type { YTransport } from "../base";
import type { ClientContext } from "../base";
import type { ReceivedMessage } from "../protocol";

export interface RateLimitOptions {
  /**
   * Maximum number of messages per window
   * @default 100
   */
  maxMessages: number;

  /**
   * Time window in milliseconds
   * @default 1000 (1 second)
   */
  windowMs: number;

  /**
   * Maximum message size in bytes
   * @default 10MB
   */
  maxMessageSize?: number;

  /**
   * Called when rate limit is exceeded
   */
  onRateLimitExceeded?: (details: {
    currentCount: number;
    maxMessages: number;
    windowMs: number;
    resetAt: number;
  }) => void;

  /**
   * Called when message size limit is exceeded
   */
  onMessageSizeExceeded?: (details: { size: number; maxSize: number }) => void;
}

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

/**
 * A transport wrapper that implements rate limiting using the token bucket algorithm
 */
export class RateLimitedTransport<
  Context extends ClientContext,
  AdditionalProps extends Record<string, unknown>,
> {
  public readable: ReadableStream<ReceivedMessage<Context>>;
  public writable: WritableStream<ReceivedMessage<Context>>;

  private maxMessages: number;
  private windowMs: number;
  private maxMessageSize: number;
  private onRateLimitExceeded?: RateLimitOptions["onRateLimitExceeded"];
  private onMessageSizeExceeded?: RateLimitOptions["onMessageSizeExceeded"];
  private bucket: TokenBucket;

  constructor(
    transport: YTransport<Context, AdditionalProps>,
    options: RateLimitOptions,
  ) {
    this.maxMessages = options.maxMessages;
    this.windowMs = options.windowMs;
    this.maxMessageSize = options.maxMessageSize ?? 1024 * 1024 * 10; // 10MB default
    this.onRateLimitExceeded = options.onRateLimitExceeded;
    this.onMessageSizeExceeded = options.onMessageSizeExceeded;

    // Initialize token bucket
    this.bucket = {
      tokens: this.maxMessages,
      lastRefill: Date.now(),
    };

    // Initialize transport streams with rate limiting
    this.readable = this.createRateLimitedReadable(transport.readable);
    this.writable = this.createRateLimitedWritable(transport.writable);
  }

  /**
   * Refill the token bucket based on elapsed time
   */
  private refillBucket() {
    const now = Date.now();
    const timePassed = now - this.bucket.lastRefill;
    const tokensToAdd = Math.floor(
      (timePassed * this.maxMessages) / this.windowMs,
    );

    this.bucket.tokens = Math.min(
      this.maxMessages,
      this.bucket.tokens + tokensToAdd,
    );
    this.bucket.lastRefill = now;
  }

  /**
   * Check if a message can be sent based on rate limits
   */
  private checkRateLimit(): boolean {
    this.refillBucket();

    if (this.bucket.tokens <= 0) {
      this.onRateLimitExceeded?.({
        currentCount: this.maxMessages - this.bucket.tokens,
        maxMessages: this.maxMessages,
        windowMs: this.windowMs,
        resetAt: this.bucket.lastRefill + this.windowMs,
      });
      return false;
    }

    this.bucket.tokens--;
    return true;
  }

  /**
   * Check if a message size is within limits
   */
  private checkMessageSize(message: unknown): boolean {
    const size = new TextEncoder().encode(JSON.stringify(message)).length;
    if (size > this.maxMessageSize) {
      this.onMessageSizeExceeded?.({
        size,
        maxSize: this.maxMessageSize,
      });
      return false;
    }
    return true;
  }

  /**
   * Create a rate-limited writable stream
   */
  private createRateLimitedWritable(
    writable: WritableStream<ReceivedMessage<Context>>,
  ): WritableStream<ReceivedMessage<Context>> {
    const writer = writable.getWriter();

    return new WritableStream<ReceivedMessage<Context>>({
      write: async (chunk) => {
        if (!this.checkMessageSize(chunk)) {
          throw new Error("Message size limit exceeded");
        }

        if (!this.checkRateLimit()) {
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
    readable: ReadableStream<ReceivedMessage<Context>>,
  ): ReadableStream<ReceivedMessage<Context>> {
    return readable.pipeThrough(
      new TransformStream<ReceivedMessage<Context>, ReceivedMessage<Context>>({
        transform: async (chunk, controller) => {
          if (!this.checkMessageSize(chunk)) {
            throw new Error("Message size limit exceeded");
          }

          if (!this.checkRateLimit()) {
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
  Context extends ClientContext,
  AdditionalProps extends Record<string, unknown>,
>(
  transport: YTransport<Context, AdditionalProps>,
  options: RateLimitOptions,
): YTransport<Context, AdditionalProps> {
  const rateLimited = new RateLimitedTransport(transport, options);

  return {
    ...transport,
    readable: rateLimited.readable,
    writable: rateLimited.writable,
  };
}
