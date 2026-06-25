/**
 * Bidirectional adapters between AsyncIterable<T[]> and ReadableStream<T>.
 * Standard JS only — works in browsers and all server runtimes.
 */

/**
 * Convert a batched async iterable into a ReadableStream.
 * Each item in each batch becomes a separate chunk in the stream.
 */
export function toReadableStream<T>(source: AsyncIterable<T[]>): ReadableStream<T> {
  const iterator = source[Symbol.asyncIterator]();

  return new ReadableStream<T>({
    async pull(controller) {
      const { value, done } = await iterator.next();
      if (done) {
        controller.close();
        return;
      }
      for (const item of value) {
        controller.enqueue(item);
      }
    },
    cancel() {
      iterator.return?.();
    },
  });
}

/**
 * Convert a ReadableStream into a batched async iterable. Each chunk is
 * yielded as its own single-item batch.
 */
export async function* fromReadableStream<T>(stream: ReadableStream<T>): AsyncIterable<T[]> {
  const reader = stream.getReader();

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      yield [value];
    }
  } finally {
    reader.releaseLock();
  }
}
