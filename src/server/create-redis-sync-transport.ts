import type { ServerContext } from "teleportal";
import type { ServerSyncTransport } from "./sync-transport";
import { NoopSyncTransport } from "./sync-transport";

/**
 * Factory function to create a Redis sync transport.
 * This dynamically imports the Redis transport to avoid bundling Redis when not needed.
 */
export async function createRedisSyncTransport<Context extends ServerContext>(
  options: {
    connection: string | {
      host?: string;
      port?: number;
      password?: string;
      db?: number;
      [key: string]: any;
    };
    keyPrefix?: string;
    options?: any;
  }
): Promise<ServerSyncTransport<Context>> {
  try {
    const { RedisSyncTransport } = await import("./redis-sync-transport");
    return new RedisSyncTransport<Context>(options);
  } catch (error) {
    console.error("Failed to create Redis sync transport:", error);
    console.warn("Falling back to noop sync transport");
    return new NoopSyncTransport<Context>();
  }
}

/**
 * Create a Redis sync transport from a connection string.
 * Returns a noop transport if the connection string is not provided.
 */
export async function createRedisSyncTransportFromConnectionString<Context extends ServerContext>(
  connectionString?: string,
  options?: {
    keyPrefix?: string;
    options?: any;
  }
): Promise<ServerSyncTransport<Context>> {
  if (!connectionString) {
    return new NoopSyncTransport<Context>();
  }
  
  return createRedisSyncTransport<Context>({
    connection: connectionString,
    keyPrefix: options?.keyPrefix,
    options: options?.options,
  });
}