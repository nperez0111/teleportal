import type { Storage } from "unstorage";

/**
 * Options for transaction locking
 */
export interface TransactionOptions {
  /**
   * Time to live for the lock in milliseconds
   */
  ttl: number;
  /**
   * Maximum number of retry attempts (default: 50)
   */
  maxRetries?: number;
  /**
   * Base delay for exponential backoff in milliseconds (default: 50)
   */
  baseDelay?: number;
  /**
   * Maximum delay cap in milliseconds (default: 5000)
   */
  maxDelay?: number;
}

/**
 * Execute a transaction with TTL-based locking using exponential backoff.
 * Prevents stack overflow, thundering herd, and infinite retries.
 *
 * @param storage - The unstorage instance
 * @param key - The key to lock
 * @param cb - The callback to execute within the transaction
 * @param options - Transaction options
 * @returns The result of the callback
 */
export async function withTransaction<T>(
  storage: Storage,
  key: string,
  cb: (key: string) => Promise<T>,
  options: TransactionOptions,
): Promise<T> {
  const maxRetries = options.maxRetries ?? 50;
  const baseDelay = options.baseDelay ?? 50;
  const maxDelay = options.maxDelay ?? 5000;
  let retries = 0;

  while (retries < maxRetries) {
    const meta = await storage.getMeta(key);
    const lockedTTL = meta?.ttl;

    if (lockedTTL && lockedTTL > Date.now()) {
      // Calculate exponential backoff with jitter to prevent thundering herd
      const exponentialDelay = baseDelay * Math.pow(2, retries);
      const jitter = Math.random() * baseDelay; // Random jitter between 0-baseDelay ms
      const waitTime = Math.min(exponentialDelay + jitter, maxDelay);

      await new Promise((resolve) => setTimeout(resolve, waitTime));
      retries++;
      continue;
    }

    // Try to acquire the lock
    const ttl = Date.now() + options.ttl;
    const lockId = Math.random().toString(36).substring(2);
    await storage.setMeta(key, { ttl, lockId, ...meta });

    // Verify we acquired the lock (fix for race conditions)
    const currentMeta = await storage.getMeta(key);
    if (currentMeta?.lockId !== lockId) {
      retries++;
      // Calculate exponential backoff
      const exponentialDelay = baseDelay * Math.pow(2, retries);
      const jitter = Math.random() * baseDelay;
      const waitTime = Math.min(exponentialDelay + jitter, maxDelay);
      await new Promise((resolve) => setTimeout(resolve, waitTime));
      continue;
    }

    try {
      const result = await cb(key);
      // Release the lock only if we still hold it (check lockId to prevent releasing another transaction's lock)
      const currentMeta = await storage.getMeta(key);
      if (currentMeta?.lockId === lockId) {
        await storage.setMeta(key, { ttl: Date.now(), ...meta });
      }
      return result;
    } catch (error) {
      // Release the lock on error, but only if we still hold it
      const currentMeta = await storage.getMeta(key);
      if (currentMeta?.lockId === lockId) {
        await storage.setMeta(key, { ttl: Date.now(), ...meta });
      }
      throw error;
    }
  }

  throw new Error(
    `Transaction lock acquisition failed after ${maxRetries} retries for key: ${key}`,
  );
}
