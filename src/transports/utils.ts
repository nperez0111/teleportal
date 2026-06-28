import {
  Source,
  Sink,
  Transport,
  decodeMessage,
  type BinaryMessage,
  type Message,
  BinaryTransport,
  encodePongMessage,
  isPingMessage,
  MessageArray,
  decodeMessageArray,
  encodeMessageArray,
  ClientContext,
  RawReceivedMessage,
} from "teleportal";
import { createBroadcast } from "../lib/iter";

export type { Channel, ChannelOptions } from "../lib/iter";
export { createChannel } from "../lib/iter";

// ---------------------------------------------------------------------------
// Fan-out (broadcast) — replaces createFanOutWriter
// ---------------------------------------------------------------------------

export type FanOutReader<T> = {
  /**
   * Unsubscribe from further messages from the fan out writer
   */
  unsubscribe: () => void;
  /**
   * A readable stream to read messages from the fan out writer
   */
  source: AsyncIterable<T[]>;
};

/**
 * Creates a writer which will fan out to all connected readers.
 */
export function createFanOutWriter<T>() {
  const bc = createBroadcast<T>();

  function getReader(): FanOutReader<T> {
    // `subscribe()` already registers the subscriber; grab its iterator once so
    // `source` and `unsubscribe` share the same instance (the channel allows a
    // single consumer, and `return()` is idempotent).
    const iterator = bc.subscribe()[Symbol.asyncIterator]();
    return {
      source: { [Symbol.asyncIterator]: () => iterator },
      unsubscribe: () => void iterator.return?.(),
    };
  }

  return {
    send(item: T): void {
      bc.send(item);
    },
    close(): void {
      bc.close();
    },
    getReader,
  };
}

// ---------------------------------------------------------------------------
// Serial queue — unchanged, already not stream-based
// ---------------------------------------------------------------------------

export type SerialQueue<T> = {
  /**
   * Enqueue an item. Items are processed strictly in enqueue order, one at a
   * time. The returned promise resolves once THIS item has finished processing
   * (or rejects if processing it threw) — giving callers a precise "applied"
   * signal without polling or event sniffing.
   */
  enqueue: (item: T) => Promise<void>;
  /** Stop accepting new items; in-flight processing is left to settle. */
  close: () => void;
};

/**
 * A minimal serial async queue: a single ordered pipeline around an async sink.
 *
 * Unlike a WritableStream used as a fan-in (where a writer resolves on enqueue,
 * not on consumption), this resolves each `enqueue` only after the sink has
 * finished processing that item. A failed item rejects its own `enqueue`
 * promise but does not poison the queue — subsequent items still run in order.
 */
export function createSerialQueue<T>(process: (item: T) => Promise<void> | void): SerialQueue<T> {
  let tail: Promise<void> = Promise.resolve();
  let closed = false;
  return {
    enqueue(item: T): Promise<void> {
      if (closed) return Promise.resolve();
      const run = tail.then(() => (closed ? undefined : process(item)));
      tail = run.then(
        () => {},
        () => {},
      );
      return run;
    },
    close() {
      closed = true;
    },
  };
}

// ---------------------------------------------------------------------------
// Compose / connect helpers
// ---------------------------------------------------------------------------

/**
 * Compose a {@link Source} and {@link Sink} into a {@link Transport}.
 */
export function compose<
  Context extends Record<string, unknown>,
  SourceAdditionalProperties extends Record<string, unknown>,
  SinkAdditionalProperties extends Record<string, unknown>,
>(
  source: Source<Context, SourceAdditionalProperties>,
  sink: Sink<Context, SinkAdditionalProperties>,
): Transport<Context, SourceAdditionalProperties & SinkAdditionalProperties> {
  // Spread both, but ensure `source` (the iterable) always comes from the
  // Source arg and `write`/`close` always come from the Sink arg.  Without
  // this, passing a Transport as the Sink would let its `source` property
  // shadow the Source's filtered/wrapped one.
  const { write, close } = sink;
  return {
    ...source,
    ...sink,
    source: source.source,
    write,
    close,
  } as Transport<Context, SourceAdditionalProperties & SinkAdditionalProperties>;
}

/**
 * Drain a batched source one item at a time, awaiting `fn` for each. Accepts a
 * {@link Source} or a bare `AsyncIterable<T[]>`.
 */
export async function forEachMessage<T>(
  source: { source: AsyncIterable<T[]> } | AsyncIterable<T[]>,
  fn: (item: T) => void | Promise<void>,
): Promise<void> {
  const iterable = "source" in source ? source.source : source;
  for await (const batch of iterable) {
    for (const item of batch) {
      await fn(item);
    }
  }
}

/**
 * Connect a source to a sink — consume all messages from source and write to sink.
 */
export function connect<Context extends Record<string, unknown>>(
  source: Source<Context> | AsyncIterable<Message<Context>[]>,
  sink: Sink<Context>,
): Promise<void> {
  return forEachMessage(source, (msg) => sink.write(msg));
}

/**
 * Bidirectional connect between two transports.
 */
export function sync<Context extends Record<string, unknown>>(
  a: Transport<Context>,
  b: Transport<Context>,
): Promise<void> {
  return Promise.all([connect(a, b), connect(b, a)]).then(() => undefined);
}

// ---------------------------------------------------------------------------
// Batch-preserving transform helpers
//
// Sources carry `AsyncIterable<T[]>`. These lift per-item logic into a
// transform over those batches, preserving batching and never yielding an
// empty batch.
// ---------------------------------------------------------------------------

/** Map each item to one output (or drop it by returning `null`/`undefined`). */
export function mapMessages<In, Out>(
  fn: (item: In) => Out | null | undefined | Promise<Out | null | undefined>,
): (source: AsyncIterable<In[]>) => AsyncIterable<Out[]> {
  return async function* (source) {
    for await (const batch of source) {
      const out: Out[] = [];
      for (const item of batch) {
        const result = fn(item);
        const mapped = result instanceof Promise ? await result : result;
        if (mapped != null) out.push(mapped);
      }
      if (out.length > 0) yield out;
    }
  };
}

/** Expand each item into zero or more outputs. */
export function flatMapMessages<In, Out>(
  fn: (item: In) => Iterable<Out>,
): (source: AsyncIterable<In[]>) => AsyncIterable<Out[]> {
  return async function* (source) {
    for await (const batch of source) {
      const out: Out[] = [];
      for (const item of batch) {
        for (const mapped of fn(item)) out.push(mapped);
      }
      if (out.length > 0) yield out;
    }
  };
}

/** Keep only items passing the (possibly async) predicate. */
export function filterMessages<T>(
  predicate: (item: T) => boolean | Promise<boolean>,
): (source: AsyncIterable<T[]>) => AsyncIterable<T[]> {
  return async function* (source) {
    for await (const batch of source) {
      const out: T[] = [];
      for (const item of batch) {
        const result = predicate(item);
        if (result instanceof Promise ? await result : result) out.push(item);
      }
      if (out.length > 0) yield out;
    }
  };
}

// ---------------------------------------------------------------------------
// Message decoding transform
// ---------------------------------------------------------------------------

/**
 * Reads an untrusted {@link BinaryMessage} and decodes it into a {@link Message}.
 */
export function decodeMessages<Context extends Record<string, unknown>>(
  context: Context | ((message: RawReceivedMessage) => Context),
): (source: AsyncIterable<BinaryMessage[]>) => AsyncIterable<Message<Context>[]> {
  return mapMessages((chunk: BinaryMessage) => {
    const decoded = decodeMessage(chunk);
    Object.assign(decoded.context, typeof context === "function" ? context(decoded) : context);
    return decoded as Message<Context>;
  });
}

// ---------------------------------------------------------------------------
// Binary ↔ Message transport conversion
// ---------------------------------------------------------------------------

/**
 * Convert a {@link Transport} to a {@link BinaryTransport}.
 *
 * This will encode all messages going in and out of the transport from {@link BinaryMessage} to {@link Message} and vice versa.
 */
export function toBinaryTransport<
  Context extends Record<string, unknown>,
  AdditionalProperties extends Record<string, unknown>,
>(
  transport: Transport<Context, AdditionalProperties>,
  _context: Context,
): BinaryTransport<AdditionalProperties> {
  return {
    ...transport,
    source: mapMessages((msg: Message<Context>) => msg.encoded)(transport.source),
    write(msg: BinaryMessage) {
      const decoded = decodeMessage(msg);
      Object.assign(decoded.context, _context);
      transport.write(decoded as Message<Context>);
    },
    close() {
      transport.close();
    },
  } as BinaryTransport<AdditionalProperties>;
}

/**
 * Convert a {@link BinaryTransport} to a {@link Transport}.
 *
 * This will decode all messages going in and out of the transport from {@link BinaryMessage} to {@link Message} and vice versa.
 */
export function fromBinaryTransport<
  Context extends Record<string, unknown>,
  AdditionalProperties extends Record<string, unknown>,
>(
  transport: BinaryTransport<AdditionalProperties>,
  context: Context,
): Transport<Context, AdditionalProperties> {
  return {
    ...transport,
    source: mapMessages((chunk: BinaryMessage) => {
      // Answer pings inline; they never surface to the decoded source.
      if (isPingMessage(chunk)) {
        transport.write(encodePongMessage());
        return null;
      }
      const decoded = decodeMessage(chunk);
      Object.assign(decoded.context, context);
      return decoded as Message<Context>;
    })(transport.source),
    write(msg: Message<Context>) {
      transport.write(msg.encoded);
    },
    close() {
      transport.close();
    },
  } as Transport<Context, AdditionalProperties>;
}

// ---------------------------------------------------------------------------
// MessageArray encoding/decoding transforms
// ---------------------------------------------------------------------------

export function toMessageArrayTransform() {
  return async function* (source: AsyncIterable<Message[]>): AsyncIterable<MessageArray[]> {
    for await (const batch of source) {
      yield [encodeMessageArray(batch)];
    }
  };
}

export function fromMessageArrayTransform<Context extends ClientContext>(context: Context) {
  return flatMapMessages((arr: MessageArray) =>
    decodeMessageArray(arr).map((msg) => {
      Object.assign(msg.context, context);
      return msg as Message<Context>;
    }),
  );
}

// ---------------------------------------------------------------------------
// Batching
// ---------------------------------------------------------------------------

export type BatchingOptions = {
  /**
   * The maximum number of messages to batch together
   */
  maxBatchSize?: number;
  /**
   * The maximum delay in milliseconds to wait before sending a batch
   */
  maxBatchDelay?: number;
};

export { batch } from "../lib/iter";
