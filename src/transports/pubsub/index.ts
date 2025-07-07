import { Redis, RedisOptions } from "ioredis";
import {
  BinaryMessage,
  compose,
  decodeMessage,
  Message,
  YSink,
  YSource,
  YTransport,
} from "teleportal";

/**
 * Redis pub/sub transport for Y.js document synchronization.
 * This transport can be used for both client-server and server-server synchronization.
 */

export function getRedisSource<Context extends Record<string, unknown>>({
  document,
  context,
  redisOptions,
}: {
  document: string;
  context: Context;
  redisOptions: {
    path: string;
    options?: RedisOptions;
  };
}): YSource<Context, {}> {
  const redis = new Redis(redisOptions.path, redisOptions.options ?? {});
  return {
    readable: new ReadableStream({
      async start(controller) {
        await redis.subscribe(document);
        redis.on("messageBuffer", (channel, message) => {
          const decoded = decodeMessage(
            new Uint8Array(message) as BinaryMessage,
          );
          Object.assign(decoded.context, context);
          controller.enqueue(decoded as Message<Context>);
        });
      },
      async cancel() {
        await redis.unsubscribe(document);
        await redis.quit();
      },
    }),
  };
}

/**
 * Multi-document Redis source that can handle multiple documents with a single connection
 */
export function getRedisMultiDocumentSource<Context extends Record<string, unknown>>({
  context,
  redisOptions,
  keyPrefix = "",
}: {
  context: Context;
  redisOptions: {
    path: string;
    options?: RedisOptions;
  };
  keyPrefix?: string;
}): YSource<Context, { redis: Redis; subscribe: (documentId: string) => Promise<void>; unsubscribe: (documentId: string) => Promise<void> }> {
  const redis = new Redis(redisOptions.path, redisOptions.options ?? {});
  const subscribedDocuments = new Set<string>();
  
  return {
    redis,
    subscribe: async (documentId: string) => {
      if (!subscribedDocuments.has(documentId)) {
        await redis.subscribe(keyPrefix + documentId);
        subscribedDocuments.add(documentId);
      }
    },
    unsubscribe: async (documentId: string) => {
      if (subscribedDocuments.has(documentId)) {
        await redis.unsubscribe(keyPrefix + documentId);
        subscribedDocuments.delete(documentId);
      }
    },
    readable: new ReadableStream({
      async start(controller) {
        redis.on("messageBuffer", (channel, message) => {
          try {
            const decoded = decodeMessage(
              new Uint8Array(message) as BinaryMessage,
            );
            Object.assign(decoded.context, context);
            controller.enqueue(decoded as Message<Context>);
          } catch (error) {
            console.error("Error decoding Redis message:", error);
          }
        });
      },
      async cancel() {
        // Unsubscribe from all documents
        for (const documentId of subscribedDocuments) {
          await redis.unsubscribe(keyPrefix + documentId);
        }
        subscribedDocuments.clear();
        await redis.quit();
      },
    }),
  };
}

export function getRedisSink<Context extends Record<string, unknown>>({
  document,
  redisOptions,
}: {
  document: string;
  redisOptions: {
    path: string;
    options?: RedisOptions;
  };
}): YSink<Context, { redis: Redis }> {
  const redis = new Redis(redisOptions.path, redisOptions.options ?? {});
  return {
    redis,
    writable: new WritableStream({
      async write(chunk) {
        if (chunk.document === document) {
          await redis.publish(chunk.document, new Uint8Array(chunk.encoded));
        }
      },
      async close() {
        await redis.quit();
      },
      abort() {
        redis.disconnect(false);
      },
    }),
  };
}

/**
 * Multi-document Redis sink that can handle multiple documents with a single connection
 */
export function getRedisMultiDocumentSink<Context extends Record<string, unknown>>({
  redisOptions,
  keyPrefix = "",
}: {
  redisOptions: {
    path: string;
    options?: RedisOptions;
  };
  keyPrefix?: string;
}): YSink<Context, { redis: Redis }> {
  const redis = new Redis(redisOptions.path, redisOptions.options ?? {});
  return {
    redis,
    writable: new WritableStream({
      async write(chunk) {
        try {
          const channel = keyPrefix + chunk.document;
          await redis.publish(channel, new Uint8Array(chunk.encoded));
        } catch (error) {
          console.error("Error publishing to Redis:", error);
        }
      },
      async close() {
        await redis.quit();
      },
      abort() {
        redis.disconnect(false);
      },
    }),
  };
}

export function getRedisTransport<Context extends Record<string, unknown>>({
  document,
  context,
  redisOptions,
}: {
  document: string;
  context: Context;
  redisOptions: {
    path: string;
    options?: RedisOptions;
  };
}): YTransport<Context, { redis: Redis }> {
  return compose(
    getRedisSource({
      document,
      context,
      redisOptions,
    }),
    getRedisSink({
      document,
      redisOptions,
    }),
  );
}

/**
 * Multi-document Redis transport that can handle multiple documents with shared connections
 */
export function getRedisMultiDocumentTransport<Context extends Record<string, unknown>>({
  context,
  redisOptions,
  keyPrefix = "",
}: {
  context: Context;
  redisOptions: {
    path: string;
    options?: RedisOptions;
  };
  keyPrefix?: string;
}) {
  const source = getRedisMultiDocumentSource({
    context,
    redisOptions,
    keyPrefix,
  });
  const sink = getRedisMultiDocumentSink({
    redisOptions,
    keyPrefix,
  });
  
  return {
    ...source,
    ...sink,
    readable: source.readable,
    writable: sink.writable,
  };
}
