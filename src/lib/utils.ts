import { createHooks } from "hookable";
import {
  BinaryMessage,
  DurablePubSub,
  DurableSubscribeOptions,
  PublishOptions,
  PubSubOffset,
  PubSubTopic,
  SubscribeOptions,
} from "teleportal";

export class Observable<EVENTS extends Record<string, (...args: any[]) => void>> {
  #hooks = createHooks<EVENTS>();

  /**
   * Listen for a named event.
   */
  on = this.#hooks.hook.bind(this.#hooks);

  /**
   * Listen for a named event once.
   */
  once = this.#hooks.hookOnce.bind(this.#hooks);

  /**
   * Remove a listener for a named event.
   */
  off = this.#hooks.removeHook.bind(this.#hooks);

  /**
   * Call a named event in serial.
   *
   * @note This is useful for events that need to be called in order.
   */
  callSerial = this.#hooks.callHook.bind(this.#hooks);

  /**
   * Call a named event in parallel.
   *
   * @note This is useful for general broadcast events.
   */
  call = this.#hooks.callHookParallel.bind(this.#hooks);

  /**
   * Remove all listeners for all events.
   */
  destroy() {
    this.#hooks.removeAllHooks();
  }

  /**
   * Add a listener for a named event.
   */
  addListeners = this.#hooks.addHooks.bind(this.#hooks);
}

interface DurableEntry {
  offset: PubSubOffset;
  message: BinaryMessage;
  sourceId: string;
}

type DurableSubscriber = (
  message: BinaryMessage,
  sourceId: string,
  offset: PubSubOffset | undefined,
) => void;

/** Zero-padding width so decimal offsets compare correctly as strings. */
const OFFSET_WIDTH = 20;

/**
 * Simple in-memory pub/sub backend implementation for testing/development.
 *
 * Implements {@link DurablePubSub}: durable messages are retained in a per-topic ring buffer
 * (default {@link maxLen} 1000) so a {@link subscribeDurable} consumer can replay from an
 * offset. Ephemeral publishes bypass the buffer (delivered live only, never replayed). Plain
 * {@link subscribe} delegates to the durable path with `start: "new"` and drops offsets.
 */
export class InMemoryPubSub implements DurablePubSub {
  public readonly durable = true as const;

  #maxLen: number;
  #counter = 0;
  #buffers = new Map<PubSubTopic, DurableEntry[]>();
  /** Highest offset evicted from each topic's ring — the boundary for gap detection. */
  #evictedMax = new Map<PubSubTopic, PubSubOffset>();
  #subscribers = new Map<PubSubTopic, Set<DurableSubscriber>>();

  constructor(options?: { maxLen?: number }) {
    this.#maxLen = options?.maxLen ?? 1000;
  }

  #nextOffset(): PubSubOffset {
    return String(++this.#counter).padStart(OFFSET_WIDTH, "0");
  }

  async publish(
    topic: PubSubTopic,
    message: BinaryMessage,
    sourceId: string,
    options?: PublishOptions,
  ): Promise<void> {
    if (options?.ephemeral) {
      this.#deliver(topic, message, sourceId, undefined);
      return;
    }

    const offset = this.#nextOffset();
    let buffer = this.#buffers.get(topic);
    if (!buffer) {
      buffer = [];
      this.#buffers.set(topic, buffer);
    }
    buffer.push({ offset, message, sourceId });
    while (buffer.length > this.#maxLen) {
      const evicted = buffer.shift()!;
      this.#evictedMax.set(topic, evicted.offset);
    }

    this.#deliver(topic, message, sourceId, offset);
  }

  #deliver(
    topic: PubSubTopic,
    message: BinaryMessage,
    sourceId: string,
    offset: PubSubOffset | undefined,
  ): void {
    const subs = this.#subscribers.get(topic);
    if (!subs) {
      return;
    }
    // Snapshot so a callback that (un)subscribes mid-delivery doesn't mutate the live set.
    const snapshot = Array.from(subs);
    for (const sub of snapshot) {
      sub(message, sourceId, offset);
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
    callback: DurableSubscriber,
    options?: DurableSubscribeOptions,
  ): Promise<() => Promise<void>> {
    const start = options?.start ?? "new";
    if (typeof start === "object") {
      const after = start.after;
      // If any evicted entry had an offset past the resume point, messages the consumer
      // wanted were trimmed out of retention → signal a gap, then replay what remains.
      const evictedMax = this.#evictedMax.get(topic);
      if (evictedMax !== undefined && evictedMax > after) {
        options?.onGap?.(topic);
      }
      for (const entry of this.#buffers.get(topic) ?? []) {
        if (entry.offset > after) {
          callback(entry.message, entry.sourceId, entry.offset);
        }
      }
    }

    let subs = this.#subscribers.get(topic);
    if (!subs) {
      subs = new Set();
      this.#subscribers.set(topic, subs);
    }
    subs.add(callback);

    return async () => {
      const set = this.#subscribers.get(topic);
      if (set) {
        set.delete(callback);
        if (set.size === 0) {
          this.#subscribers.delete(topic);
        }
      }
    };
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.#subscribers.clear();
    this.#buffers.clear();
    this.#evictedMax.clear();
  }
}
