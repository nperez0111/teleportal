import { createChannel, type Channel, type ChannelOptions } from "./channel";

/**
 * Fan-out: broadcast items to N subscriber channels.
 *
 * Each subscriber gets its own Channel with independent buffering and
 * compaction. If a subscriber's buffer overflows, only that subscriber
 * is dropped — the broadcast and other subscribers continue.
 */
export interface Broadcast<T> {
  /** Fan out one item to all subscriber channels. */
  send(item: T): void;
  /** Create a new subscriber channel. Does NOT replay past messages. */
  subscribe(): AsyncIterable<T[]>;
  /** End all subscriber iterations. */
  close(): void;
}

export function createBroadcast<T>(subscriberOpts?: Omit<ChannelOptions<T>, never>): Broadcast<T> {
  const subscribers = new Set<Channel<T>>();
  let closed = false;

  function send(item: T): void {
    for (const sub of subscribers) {
      // Subscriber overflow or closed — remove it.
      if (!sub.trySend(item)) subscribers.delete(sub);
    }
  }

  function subscribe(): AsyncIterable<T[]> {
    if (closed) throw new Error("Broadcast is closed");
    const ch = createChannel<T>(subscriberOpts);
    subscribers.add(ch);

    // Wrap so that breaking out of for-await removes the subscriber
    return {
      [Symbol.asyncIterator]() {
        const iter = ch[Symbol.asyncIterator]();
        return {
          next: () => iter.next(),
          return() {
            subscribers.delete(ch);
            return iter.return!();
          },
        };
      },
    };
  }

  function close(): void {
    if (closed) return;
    closed = true;
    for (const sub of subscribers) {
      sub.close();
    }
    subscribers.clear();
  }

  return { send, subscribe, close };
}
