import type { Message, ServerContext, YTransport } from "teleportal";
import type { Logger } from "./logger";

/**
 * Interface for server sync transport that can handle multiple documents
 */
export interface ServerSyncTransport<Context extends ServerContext> extends YTransport<Context, any> {
  /**
   * Subscribe to updates for a specific document
   */
  subscribe(documentId: string): Promise<void>;
  
  /**
   * Unsubscribe from updates for a specific document
   */
  unsubscribe(documentId: string): Promise<void>;
  
  /**
   * Close the transport and clean up resources
   */
  close(): Promise<void>;
}

/**
 * No-op implementation that does nothing
 */
export function createNoopServerSyncTransport<Context extends ServerContext>(): ServerSyncTransport<Context> {
  return {
    readable: new ReadableStream(),
    writable: new WritableStream(),
    subscribe: async () => {},
    unsubscribe: async () => {},
    close: async () => {},
  };
}

/**
 * Create a Redis server sync transport using the existing pubsub transport
 */
export async function createRedisServerSyncTransport<Context extends ServerContext>(
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
  },
  context: Context,
  logger: Logger
): Promise<ServerSyncTransport<Context>> {
  try {
    // Convert connection object to string if needed
    let connectionPath: string;
    if (typeof options.connection === 'string') {
      connectionPath = options.connection;
    } else {
      const { host = 'localhost', port = 6379, password, db = 0 } = options.connection;
      connectionPath = `redis://${password ? `:${password}@` : ''}${host}:${port}/${db}`;
    }
    
    const redisOptions = {
      path: connectionPath,
      options: options.options,
    };
    
    logger.trace("creating Redis server sync transport");
    
    // Dynamic import to avoid bundling Redis when not needed
    const { getRedisMultiDocumentTransport } = await import("../transports/pubsub");
    
    const transport = getRedisMultiDocumentTransport({
      context,
      redisOptions,
      keyPrefix: options.keyPrefix || "teleportal:sync:",
    });

    return {
      readable: transport.readable,
      writable: transport.writable,
      subscribe: transport.subscribe,
      unsubscribe: transport.unsubscribe,
      close: async () => {
        try {
          await transport.redis.quit();
          logger.trace("Redis server sync transport closed");
        } catch (error) {
          logger.withError(error).error("failed to close Redis server sync transport");
        }
      },
    };
  } catch (error) {
    logger.withError(error).error("failed to create Redis server sync transport");
    logger.warn("falling back to noop server sync transport");
    return createNoopServerSyncTransport<Context>();
  }
}

/**
 * Create a Redis server sync transport from a connection string
 */
export async function createRedisServerSyncTransportFromConnectionString<Context extends ServerContext>(
  connectionString: string,
  context: Context,
  logger: Logger,
  options?: {
    keyPrefix?: string;
    options?: any;
  }
): Promise<ServerSyncTransport<Context>> {
  return createRedisServerSyncTransport<Context>(
    {
      connection: connectionString,
      keyPrefix: options?.keyPrefix,
      options: options?.options,
    },
    context,
    logger
  );
}