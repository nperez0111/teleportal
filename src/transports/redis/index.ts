import { Redis, RedisOptions } from "ioredis";
import {
  BinaryMessage,
  decodePubSubMessage,
  type DurablePubSub,
  type DurableSubscribeOptions,
  encodePubSubMessage,
  Message,
  PubSub,
  type PublishOptions,
  type PubSubOffset,
  PubSubTopic,
  RawReceivedMessage,
  ServerContext,
  type SubscribeOptions,
  Transport,
} from "teleportal";
import { emitWideEvent } from "teleportal/server";
import { getPubSubTransport } from "../pubSub";

export { RedisRateLimitStorage } from "./rate-limit-storage";

/**
 * Tuning for the durable (Redis Streams) side of {@link RedisPubSub}.
 */
export interface RedisStreamOptions {
  /** Key prefix for per-topic streams. Default `"teleportal:stream:"`. */
  keyPrefix?: string;
  /** Approximate (`MAXLEN ~`) retention cap per stream. Default 10_000. */
  maxLen?: number;
  /** Rolling `PEXPIRE` applied on every publish (ms). Default off. */
  ttlMs?: number;
  /** `XREAD ... BLOCK` timeout (ms). Default 1000. */
  blockMs?: number;
  /** `XREAD COUNT` per iteration. Default 128. */
  readCount?: number;
  /**
   * Whether a topic uses the durable stream. Default: `document/*` is durable, everything else
   * (`ack/*`, `client/*`, …) stays on plain fire-and-forget pub/sub. Returning `false` for all
   * topics fully restores plain pub/sub behaviour with zero stream overhead.
   */
  isDurableTopic?: (topic: PubSubTopic) => boolean;
}

type DurableCallback = (
  message: BinaryMessage,
  sourceId: string,
  offset: PubSubOffset | undefined,
) => void;

interface StreamTopicState {
  lastId: string;
  callbacks: Set<DurableCallback>;
  onGap?: (topic: PubSubTopic) => void;
}

/** Compare two Redis stream ids (`ms-seq`). */
function idGreater(a: string, b: string): boolean {
  const [am, as_] = a.split("-");
  const [bm, bs_] = b.split("-");
  const amn = BigInt(am || "0");
  const bmn = BigInt(bm || "0");
  if (amn !== bmn) return amn > bmn;
  return BigInt(as_ || "0") > BigInt(bs_ || "0");
}

/**
 * Redis implementation of {@link DurablePubSub}.
 *
 * Durable topics (`document/*` by default) are persisted to a per-topic Redis Stream via `XADD`
 * and consumed by a single multiplexed blocking `XREAD` loop that resumes from the last-read id
 * after a connection blip — so a briefly disconnected node catches up on everything it missed.
 * Ephemeral publishes and non-durable topics use plain `PUBLISH`/`SUBSCRIBE` fire-and-forget.
 */
export class RedisPubSub implements DurablePubSub {
  public readonly durable = true as const;

  #publisher: Redis;
  #subscriber: Redis;
  #command: Redis;
  #streamRead: Redis;

  #keyPrefix: string;
  #maxLen: number;
  #ttlMs: number | undefined;
  #blockMs: number;
  #readCount: number;
  #isDurableTopic: (topic: PubSubTopic) => boolean;

  #streamState = new Map<PubSubTopic, StreamTopicState>();
  #plainCallbacks = new Map<PubSubTopic, Set<(m: BinaryMessage, s: string) => void>>();
  #plainHandlerInstalled = false;
  #readLoopRunning = false;
  #reconnectGapCheck = false;
  #stopped = false;

  constructor(redisOptions: { path: string; options?: RedisOptions; stream?: RedisStreamOptions }) {
    const opts = redisOptions.options ?? {};
    this.#publisher = new Redis(redisOptions.path, opts);
    this.#subscriber = new Redis(redisOptions.path, opts);
    this.#command = new Redis(redisOptions.path, opts);
    this.#streamRead = new Redis(redisOptions.path, opts);
    // Blocking XREAD errors are handled in the read loop; swallow connection noise elsewhere.
    for (const c of [this.#publisher, this.#subscriber, this.#command, this.#streamRead]) {
      c.on("error", () => {});
    }

    const s = redisOptions.stream ?? {};
    this.#keyPrefix = s.keyPrefix ?? "teleportal:stream:";
    this.#maxLen = s.maxLen ?? 10_000;
    this.#ttlMs = s.ttlMs;
    this.#blockMs = s.blockMs ?? 1000;
    this.#readCount = s.readCount ?? 128;
    this.#isDurableTopic = s.isDurableTopic ?? ((topic) => topic.startsWith("document/"));
  }

  #streamKey(topic: PubSubTopic): string {
    return this.#keyPrefix + topic;
  }

  async publish(
    topic: PubSubTopic,
    message: BinaryMessage,
    sourceId: string,
    options?: PublishOptions,
  ): Promise<void> {
    const encoded = encodePubSubMessage(message, sourceId);
    if (this.#isDurableTopic(topic) && !options?.ephemeral) {
      const key = this.#streamKey(topic);
      await this.#command.xadd(key, "MAXLEN", "~", this.#maxLen, "*", "d", Buffer.from(encoded));
      if (this.#ttlMs) {
        await this.#command.pexpire(key, this.#ttlMs);
      }
    } else {
      await this.#publisher.publish(topic, Buffer.from(encoded));
    }
  }

  async subscribe(
    topic: PubSubTopic,
    callback: (message: BinaryMessage, sourceId: string) => void,
    options?: SubscribeOptions,
  ): Promise<() => Promise<void>> {
    return this.subscribeDurable(topic, (message, sourceId) => callback(message, sourceId), {
      start: "new",
      onGap: options?.onGap,
    });
  }

  async subscribeDurable(
    topic: PubSubTopic,
    callback: DurableCallback,
    options?: DurableSubscribeOptions,
  ): Promise<() => Promise<void>> {
    if (!this.#isDurableTopic(topic)) {
      // Non-durable topic: everything is plain fire-and-forget, offsets are undefined.
      return this.#subscribePlain(topic, (m, s) => callback(m, s, undefined));
    }
    // Durable topic: fan in the stream (durable, offset defined) and the plain channel
    // (ephemeral publishes to the same topic, offset undefined).
    const unsubStream = await this.#subscribeStream(topic, callback, options);
    const unsubPlain = await this.#subscribePlain(topic, (m, s) => callback(m, s, undefined));
    return async () => {
      await unsubStream();
      await unsubPlain();
    };
  }

  async #subscribeStream(
    topic: PubSubTopic,
    callback: DurableCallback,
    options?: DurableSubscribeOptions,
  ): Promise<() => Promise<void>> {
    // NOTE: all subscribers to a topic share one multiplexed read position (`lastId`). The first
    // subscribe fixes the position; a *later* subscribe to the same topic joins at the current
    // position and its `start: { after }` / `onGap` are ignored. Teleportal subscribes each topic
    // once per node, so this only affects the experimental external-replay use of
    // `subscribeDurable` — for independent replay, use a separate `RedisPubSub` instance.
    const key = this.#streamKey(topic);
    let state = this.#streamState.get(topic);
    if (!state) {
      const start = options?.start ?? "new";
      let lastId: string;
      if (typeof start === "object") {
        lastId = start.after;
        // If the oldest retained entry is already newer than the resume point, messages the
        // consumer wanted were trimmed out of retention → signal a gap.
        const oldest = await this.#oldestId(key);
        if (oldest && idGreater(oldest, lastId)) {
          options?.onGap?.(topic);
        }
      } else {
        // Pin at the newest existing id so `start: "new"` skips the backlog. Missing/empty
        // stream → "0" (read everything published from now on).
        lastId = await this.#newestId(key);
      }
      state = { lastId, callbacks: new Set(), onGap: options?.onGap };
      this.#streamState.set(topic, state);
    } else if (options?.onGap && !state.onGap) {
      state.onGap = options.onGap;
    }
    state.callbacks.add(callback);
    this.#ensureReadLoop();

    return async () => {
      const s = this.#streamState.get(topic);
      if (s) {
        s.callbacks.delete(callback);
        if (s.callbacks.size === 0) {
          this.#streamState.delete(topic);
        }
      }
    };
  }

  async #subscribePlain(
    topic: PubSubTopic,
    callback: (m: BinaryMessage, s: string) => void,
  ): Promise<() => Promise<void>> {
    if (!this.#plainHandlerInstalled) {
      this.#subscriber.on("messageBuffer", (channelBuf: Buffer, rawMessage: Buffer) => {
        const channel = channelBuf.toString() as PubSubTopic;
        const set = this.#plainCallbacks.get(channel);
        if (!set) return;
        let decoded;
        try {
          decoded = decodePubSubMessage(new Uint8Array(rawMessage));
        } catch (error) {
          emitWideEvent("error", {
            event_type: "redis_decode_error",
            timestamp: new Date().toISOString(),
            topic: channel,
            error,
          });
          return;
        }
        for (const cb of Array.from(set)) {
          try {
            cb(decoded.message, decoded.sourceId);
          } catch (error) {
            // Don't let a throwing callback surface as an uncaught exception
            // inside ioredis's event emitter.
            emitWideEvent("error", {
              event_type: "redis_plain_callback_error",
              timestamp: new Date().toISOString(),
              topic: channel,
              error,
            });
          }
        }
      });
      this.#plainHandlerInstalled = true;
    }

    let set = this.#plainCallbacks.get(topic);
    if (!set) {
      set = new Set();
      this.#plainCallbacks.set(topic, set);
      await this.#subscriber.subscribe(topic);
    }
    set.add(callback);

    return async () => {
      const s = this.#plainCallbacks.get(topic);
      if (s) {
        s.delete(callback);
        if (s.size === 0) {
          this.#plainCallbacks.delete(topic);
          try {
            await this.#subscriber.unsubscribe(topic);
          } catch {
            // connection may already be gone during disposal
          }
        }
      }
    };
  }

  async #newestId(key: string): Promise<string> {
    const res = await this.#command.xrevrange(key, "+", "-", "COUNT", 1);
    return res.length > 0 ? res[0][0] : "0";
  }

  async #oldestId(key: string): Promise<string | undefined> {
    const res = await this.#command.xrange(key, "-", "+", "COUNT", 1);
    return res.length > 0 ? res[0][0] : undefined;
  }

  #ensureReadLoop(): void {
    if (this.#readLoopRunning || this.#stopped || this.#streamState.size === 0) {
      return;
    }
    this.#readLoopRunning = true;
    void this.#readLoop();
  }

  async #readLoop(): Promise<void> {
    try {
      await this.#runReadLoop();
    } finally {
      // Always clear the flag, even if a callback threw, so `#ensureReadLoop`
      // can restart the loop instead of seeing it stuck as running forever.
      this.#readLoopRunning = false;
    }
  }

  async #runReadLoop(): Promise<void> {
    while (!this.#stopped && this.#streamState.size > 0) {
      // On the first successful read after a reconnect, check whether our resume position was
      // trimmed out of retention while we were disconnected.
      if (this.#reconnectGapCheck) {
        this.#reconnectGapCheck = false;
        for (const [topic, state] of this.#streamState) {
          const oldest = await this.#oldestId(this.#streamKey(topic)).catch(() => undefined);
          if (oldest && idGreater(oldest, state.lastId)) {
            state.onGap?.(topic);
          }
        }
      }

      const entries = Array.from(this.#streamState.entries());
      const keys = entries.map(([topic]) => this.#streamKey(topic));
      const ids = entries.map(([, state]) => state.lastId);
      const keyToTopic = new Map(entries.map(([topic]) => [this.#streamKey(topic), topic]));

      let result: Array<[Buffer, Array<[Buffer, Buffer[]]>]> | null;
      try {
        result = (await (this.#streamRead as any).xreadBuffer(
          "COUNT",
          this.#readCount,
          "BLOCK",
          this.#blockMs,
          "STREAMS",
          ...keys,
          ...ids,
        )) as Array<[Buffer, Array<[Buffer, Buffer[]]>]> | null;
      } catch (error) {
        if (this.#stopped) break;
        emitWideEvent("error", {
          event_type: "redis_stream_read_error",
          timestamp: new Date().toISOString(),
          error,
        });
        this.#reconnectGapCheck = true;
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }

      if (!result) continue; // BLOCK timeout: re-issue with any newly-subscribed topics

      for (const [keyBuf, msgs] of result) {
        const topic = keyToTopic.get(keyBuf.toString());
        if (!topic) continue;
        const state = this.#streamState.get(topic);
        if (!state) continue;
        for (const [idBuf, fields] of msgs) {
          const id = idBuf.toString();
          state.lastId = id;
          const envelope = this.#extractEnvelope(fields);
          if (!envelope) continue;
          let decoded;
          try {
            decoded = decodePubSubMessage(envelope);
          } catch (error) {
            emitWideEvent("error", {
              event_type: "redis_decode_error",
              timestamp: new Date().toISOString(),
              topic,
              error,
            });
            continue;
          }
          for (const cb of Array.from(state.callbacks)) {
            try {
              cb(decoded.message, decoded.sourceId, id);
            } catch (error) {
              // A throwing callback must not escape the read loop: that would
              // leave `#readLoopRunning` stuck true and permanently halt
              // durable delivery for every stream on this node.
              emitWideEvent("error", {
                event_type: "redis_durable_callback_error",
                timestamp: new Date().toISOString(),
                topic,
                error,
              });
            }
          }
        }
      }
    }
  }

  /** Extract the `d` field (envelope bytes) from an XREAD field/value list. */
  #extractEnvelope(fields: Buffer[]): Uint8Array | undefined {
    for (let i = 0; i + 1 < fields.length; i += 2) {
      if (fields[i].toString() === "d") {
        return new Uint8Array(fields[i + 1]);
      }
    }
    return undefined;
  }

  /**
   * Test-only: destroy the blocking read connection's socket to simulate a network blip. Unlike
   * `disconnect()`, destroying the socket is treated as an unexpected drop, so ioredis
   * auto-reconnects; the read loop then resumes `XREAD` from the preserved last id and catches up.
   */
  disconnectStreamReaderForTest(): void {
    const socket = (this.#streamRead as unknown as { stream?: { destroy: (e?: Error) => void } })
      .stream;
    socket?.destroy(new Error("test-induced disconnect"));
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.#stopped = true;
    // Force the blocking XREAD connection closed so the loop unwinds immediately.
    this.#streamRead.disconnect();
    await Promise.all([
      this.#publisher.quit().catch(() => {}),
      this.#subscriber.quit().catch(() => {}),
      this.#command.quit().catch(() => {}),
    ]);
  }
}

/**
 * Multi-document Redis {@link Transport} that can handle multiple documents with shared connections
 */
export function getRedisTransport<Context extends ServerContext>({
  getContext,
  redisOptions,
  sourceId,
  topicResolver = (m) => `document/${m.document}`,
}: {
  getContext: Context | ((message: RawReceivedMessage) => Context);
  redisOptions: {
    path: string;
    options?: RedisOptions;
  };
  sourceId: string;
  topicResolver?: (message: Message<Context>) => PubSubTopic;
}): Transport<
  Context,
  {
    /**
     * The {@link PubSub} to use for consuming {@link Message}s.
     */
    pubSub: PubSub;
    /**
     * Subscribe to a topic
     */
    subscribe: (topic: PubSubTopic) => Promise<void>;
    /**
     * Unsubscribe from a topic, if no topic is provided, unsubscribe from all topics
     */
    unsubscribe: (topic?: PubSubTopic) => Promise<void>;
    /**
     * Close the transport
     */
    close: () => Promise<void>;
  }
> {
  const pubSub = new RedisPubSub(redisOptions);

  const transport = getPubSubTransport({
    getContext,
    pubSub,
    topicResolver,
    sourceId,
  });

  return {
    ...transport,
    close: async () => {
      try {
        transport.close();
      } catch {
        // Transport might already be closed
      }
      await pubSub[Symbol.asyncDispose]?.();
    },
  };
}
