/**
 * Pull-based batching: accumulate items from a source and yield when either
 * `maxSize` items are buffered or `maxDelayMs` elapses (whichever comes first).
 *
 * Remaining items flush via `try/finally` on any exit (source exhaustion,
 * consumer break, error).
 */
export async function* batch<T>(
  source: AsyncIterable<T[]>,
  opts: { maxSize?: number; maxDelayMs?: number } = {},
): AsyncIterable<T[]> {
  const { maxSize = 10, maxDelayMs = 100 } = opts;
  let buffer: T[] = [];
  const iterator = source[Symbol.asyncIterator]();

  // A single outstanding pull, reused across timeout flushes. Racing a fresh
  // `iterator.next()` each loop would abandon the losing pull and silently
  // drop whatever it later resolves with, so we hold onto it instead.
  let pending: Promise<IteratorResult<T[]>> | null = null;

  try {
    while (true) {
      if (!pending) pending = iterator.next();

      let next: IteratorResult<T[]> | "timeout";
      if (maxDelayMs > 0 && buffer.length > 0) {
        // Race: the outstanding pull vs a timeout.
        let timer: ReturnType<typeof setTimeout>;
        const timeout = new Promise<"timeout">((r) => {
          timer = setTimeout(() => r("timeout"), maxDelayMs);
        });
        next = await Promise.race([pending, timeout]);
        clearTimeout(timer!);
      } else {
        next = await pending;
      }

      if (next === "timeout") {
        // The pull is still in flight — keep `pending` so the next iteration
        // awaits the same promise rather than starting a second one.
        yield buffer;
        buffer = [];
        continue;
      }

      // This pull settled; the next iteration starts a fresh one.
      pending = null;

      if (next.done) break;

      buffer.push(...next.value);

      if (buffer.length >= maxSize) {
        yield buffer;
        buffer = [];
      }
    }
  } finally {
    // Flush remaining on any exit
    if (buffer.length > 0) yield buffer;
    await iterator.return?.();
  }
}
