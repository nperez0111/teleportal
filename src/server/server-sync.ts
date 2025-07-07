import type { Message, ServerContext, YTransport } from "teleportal";
import type { Logger } from "./logger";

/**
 * Interface for creating server sync transports per document
 */
export interface ServerSyncTransportFactory<Context extends ServerContext> {
  /**
   * Create a transport for a specific document
   */
  createTransport(documentId: string): Promise<YTransport<Context, any>>;
  
  /**
   * Close all transports and clean up resources
   */
  close(): Promise<void>;
}

/**
 * No-op implementation that creates no-op transports
 */
export class NoopServerSyncTransportFactory<Context extends ServerContext> implements ServerSyncTransportFactory<Context> {
  async createTransport(documentId: string): Promise<YTransport<Context, any>> {
    return {
      readable: new ReadableStream(),
      writable: new WritableStream(),
    };
  }
  
  async close(): Promise<void> {
    // No-op
  }
}

/**
 * Redis-based server sync transport factory using the existing pubsub transport
 */
export class RedisServerSyncTransportFactory<Context extends ServerContext> implements ServerSyncTransportFactory<Context> {
  private transports = new Map<string, YTransport<Context, any>>();
  private logger: Logger;

  constructor(
    private redisOptions: {
      path: string;
      options?: any;
    },
    private context: Context,
    logger: Logger
  ) {
    this.logger = logger.withContext({ name: "redis-server-sync" });
  }

  async createTransport(documentId: string): Promise<YTransport<Context, any>> {
    // Check if we already have a transport for this document
    const existingTransport = this.transports.get(documentId);
    if (existingTransport) {
      return existingTransport;
    }

    this.logger.trace("creating Redis transport for document", { documentId });

    try {
      // Dynamic import to avoid bundling Redis when not needed
      const { getRedisTransport } = await import("../transports/pubsub");
      
      const transport = getRedisTransport({
        document: documentId,
        context: this.context,
        redisOptions: this.redisOptions,
      });

      this.transports.set(documentId, transport);
      return transport;
    } catch (error) {
      this.logger.withError(error).error("failed to create Redis transport", { documentId });
      
      // Fall back to noop transport
      const noopTransport = {
        readable: new ReadableStream(),
        writable: new WritableStream(),
      };
      
      return noopTransport;
    }
  }

  async close(): Promise<void> {
    this.logger.trace("closing all Redis transports");
    
    // Close all transports
    for (const [documentId, transport] of this.transports) {
      try {
        if ('redis' in transport) {
          await (transport as any).redis.quit();
        }
      } catch (error) {
        this.logger.withError(error).error("failed to close Redis transport", { documentId });
      }
    }
    
    this.transports.clear();
    this.logger.trace("all Redis transports closed");
  }
}

/**
 * Create a Redis server sync transport factory
 */
export async function createRedisServerSyncTransportFactory<Context extends ServerContext>(
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
): Promise<ServerSyncTransportFactory<Context>> {
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
    
    return new RedisServerSyncTransportFactory(redisOptions, context, logger);
  } catch (error) {
    logger.withError(error).error("failed to create Redis server sync transport factory");
    logger.warn("falling back to noop server sync transport factory");
    return new NoopServerSyncTransportFactory<Context>();
  }
}

/**
 * Create a Redis server sync transport factory from a connection string
 */
export async function createRedisServerSyncTransportFactoryFromConnectionString<Context extends ServerContext>(
  connectionString?: string,
  context?: Context,
  logger?: Logger,
  options?: {
    keyPrefix?: string;
    options?: any;
  }
): Promise<ServerSyncTransportFactory<Context>> {
  if (!connectionString || !context || !logger) {
    return new NoopServerSyncTransportFactory<Context>();
  }
  
  return createRedisServerSyncTransportFactory<Context>(
    {
      connection: connectionString,
      keyPrefix: options?.keyPrefix,
      options: options?.options,
    },
    context,
    logger
  );
}