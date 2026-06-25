/**
 * A compacting inbox that bridges push-based APIs and pull-based consumption.
 *
 * Items accumulate between pulls. Each `for await` pull drains everything
 * currently buffered as one batch. An optional `compact` function runs lazily
 * at drain time to coalesce the buffer (e.g. dedup awareness, merge doc
 * updates).
 */
export interface Channel<T> {
  /** Buffer one item. Throws if the channel is closed or over capacity. */
  send(item: T): void;
  /** Like {@link send}, but returns `false` instead of throwing when the item can't be accepted. */
  trySend(item: T): boolean;
  /** Signal clean end — pending items flush, then iteration stops. */
  close(): void;
  /** Signal failure — the next pull rejects with `reason`. */
  error(reason: unknown): void;
  [Symbol.asyncIterator](): AsyncIterator<T[]>;
}

export interface ChannelOptions<T> {
  /** Maximum buffered items before `send()` throws. */
  capacity?: number;
  /** Compact the buffer lazily at drain time. */
  compact?: (items: T[]) => T[];
}

export function createChannel<T>(opts?: ChannelOptions<T>): Channel<T> {
  const capacity = opts?.capacity;
  const compact = opts?.compact;

  let buffer: T[] = [];
  let closed = false;
  let errored: unknown = undefined;
  let hasError = false;

  // When the consumer is waiting for items, this callback wakes it up.
  let notify: (() => void) | null = null;

  let consumed = false;

  function send(item: T): void {
    if (closed) throw new Error("Channel is closed");
    if (hasError) throw new Error("Channel has errored");
    if (capacity !== undefined && buffer.length >= capacity) {
      throw new Error(`Channel buffer overflow (capacity: ${capacity})`);
    }
    buffer.push(item);
    if (notify) {
      const wake = notify;
      notify = null;
      wake();
    }
  }

  function trySend(item: T): boolean {
    try {
      send(item);
      return true;
    } catch {
      return false;
    }
  }

  function close(): void {
    if (closed) return;
    closed = true;
    if (notify) {
      const wake = notify;
      notify = null;
      wake();
    }
  }

  function error(reason: unknown): void {
    if (closed) return;
    hasError = true;
    errored = reason;
    buffer.length = 0;
    if (notify) {
      const wake = notify;
      notify = null;
      wake();
    }
  }

  function asyncIterator(): AsyncIterator<T[]> {
    if (consumed) {
      throw new Error("Channel supports only a single consumer");
    }
    consumed = true;

    return {
      next(): Promise<IteratorResult<T[]>> {
        // Error takes priority
        if (hasError) {
          return Promise.reject(errored);
        }

        // Items available — drain immediately
        if (buffer.length > 0) {
          const batch = compact ? compact(buffer) : buffer;
          buffer = [];
          return Promise.resolve({ value: batch, done: false });
        }

        // Closed with no remaining items — done
        if (closed) {
          return Promise.resolve({ value: undefined as any, done: true });
        }

        // Nothing available — wait for send/close/error
        return new Promise<IteratorResult<T[]>>((resolve, reject) => {
          notify = () => {
            if (hasError) {
              reject(errored);
              return;
            }
            if (buffer.length > 0) {
              const batch = compact ? compact(buffer) : buffer;
              buffer = [];
              resolve({ value: batch, done: false });
              return;
            }
            // closed with nothing buffered
            resolve({ value: undefined as any, done: true });
          };
        });
      },

      return(): Promise<IteratorResult<T[]>> {
        closed = true;
        buffer.length = 0;
        notify = null;
        return Promise.resolve({ value: undefined as any, done: true });
      },
    };
  }

  return { send, trySend, close, error, [Symbol.asyncIterator]: asyncIterator };
}
