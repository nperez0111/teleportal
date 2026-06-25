/**
 * Consume an async iterable to completion, calling `fn` for each batch.
 * Returns a promise that resolves when the source is exhausted.
 */
export async function consume<T>(
  source: AsyncIterable<T[]>,
  fn: (batch: T[]) => void | Promise<void>,
): Promise<void> {
  for await (const batch of source) {
    await fn(batch);
  }
}
