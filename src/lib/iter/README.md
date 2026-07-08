# Async Iterator Utilities (`teleportal/iter`)

Small, dependency-free primitives for moving batched updates between push-based
producers (WebSocket callbacks, pub/sub, Y.js observers) and pull-based
consumers (`for await`). Everything works in units of **batches** — the shared
currency across Teleportal is `AsyncIterable<T[]>`, so a single pull can drain
many buffered items at once and optionally coalesce them.

Standard JS only (async iterators, `ReadableStream`, `setTimeout`). No Node or
Bun-specific APIs, so the same code runs in browsers, Workers, and on the
server.

## Exports

| Export                                          | Purpose                                                       |
| ----------------------------------------------- | ------------------------------------------------------------- |
| `createChannel<T>(opts?)`                       | Single-consumer compacting inbox bridging push → pull         |
| `createBroadcast<T>(opts?)`                     | Fan-out one item to N independent subscriber channels         |
| `batch<T>(source, opts?)`                       | Re-batch a stream by size and/or time                         |
| `consume<T>(source, fn)`                        | Drive a stream to completion, invoking `fn` per batch         |
| `toReadableStream<T>` / `fromReadableStream<T>` | Adapters between `AsyncIterable<T[]>` and `ReadableStream<T>` |

## Channel

A `Channel<T>` is a **single-consumer**, compacting inbox. Producers call
`send`; a lone consumer iterates with `for await`. Items buffer between pulls,
and **each pull drains everything currently buffered as one batch** — so a burst
of sends while the consumer is busy coalesces into a single yielded array.

```ts
import { createChannel } from "teleportal/iter";

const ch = createChannel<number>();
ch.send(1);
ch.send(2);
ch.close();

for await (const batch of ch) {
  console.log(batch); // [1, 2]  — drained as one batch
}
```

### Semantics

- **Single consumer**: calling `[Symbol.asyncIterator]()` twice throws. A
  channel has exactly one drain point.
- **Drain-on-pull**: `next()` returns the whole current buffer, then resets it.
  If the buffer is empty, the pull parks until the next `send`/`close`/`error`.
- **`close()`**: pending items flush as a final batch, then iteration ends
  cleanly (`done: true`). Sending after close throws.
- **`error(reason)`**: discards the buffer and makes the next pull reject with
  `reason`. `error()` after `close()` is a no-op (close wins).
- **Back-pressure**: with `capacity` set, `send` throws once the buffer is full;
  `trySend` returns `false` instead of throwing. Capacity is checked **before**
  compaction, so `compact` cannot be used to dodge the limit.
- **Cleanup**: breaking out of the `for await` calls the iterator's `return()`,
  which closes the channel and clears the buffer.

### Compaction

`compact` runs lazily **at drain time** over the buffered array, letting you
coalesce redundant items (e.g. keep only the latest awareness state per client,
or merge queued document updates) without doing work on every `send`:

```ts
const ch = createChannel<{ key: string; value: number }>({
  compact: (items) => {
    const latest = new Map<string, { key: string; value: number }>();
    for (const item of items) latest.set(item.key, item);
    return [...latest.values()];
  },
});
```

## Broadcast

`createBroadcast<T>` fans one item out to N subscriber channels. Each subscriber
gets its **own** `Channel` with independent buffering and (optional) compaction,
so a slow subscriber can't stall the others.

```ts
import { createBroadcast } from "teleportal/iter";

const bc = createBroadcast<number>({ capacity: 128 });
const a = bc.subscribe();
const b = bc.subscribe();

bc.send(1);
bc.close();
```

- `subscribe()` returns an `AsyncIterable<T[]>`. It does **not** replay past
  messages — a late subscriber only sees items sent after it subscribed.
- If a subscriber's buffer overflows (or it has already closed), `send` drops
  **only that subscriber**; the broadcast and every other subscriber continue.
- Breaking out of a subscriber's `for await` removes it from the fan-out set.
- `close()` ends all subscriber iterations and clears the set.

## batch

Re-batch a stream, flushing when **either** `maxSize` items accumulate **or**
`maxDelayMs` elapses (whichever comes first). Remaining items flush via
`try/finally` on any exit — source exhaustion, consumer `break`, or error.

```ts
import { batch } from "teleportal/iter";

for await (const group of batch(source, { maxSize: 50, maxDelayMs: 100 })) {
  await flush(group);
}
```

Defaults: `maxSize = 10`, `maxDelayMs = 100`. Set `maxDelayMs` to `0` to disable
the timer and batch purely by size. A single outstanding `iterator.next()` is
held across timeout flushes and reused, so no pulled value is ever silently
dropped by racing a fresh pull each loop.

## consume

Drive a stream to completion, awaiting `fn` for each batch. Resolves when the
source is exhausted.

```ts
import { consume } from "teleportal/iter";

await consume(source, async (batch) => {
  for (const item of batch) await handle(item);
});
```

## Stream adapters

Bridge to/from the Web Streams API.

- `toReadableStream(source)` — each item in each batch becomes one stream chunk.
  Cancelling the stream calls the source iterator's `return()`.
- `fromReadableStream(stream)` — each chunk is yielded as its own single-item
  batch. The reader lock is released via `try/finally`.

```ts
import { toReadableStream, fromReadableStream } from "teleportal/iter";

const stream = toReadableStream(source); // ReadableStream<T>
const iterable = fromReadableStream(stream); // AsyncIterable<T[]>
```
