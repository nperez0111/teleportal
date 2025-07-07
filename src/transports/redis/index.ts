import { Redis, RedisOptions } from "ioredis";
import { uuidv4 } from "lib0/random";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import {
  BinaryMessage,
  compose,
  decodeMessage,
  Message,
  ServerContext,
  YSink,
  YSource,
  YTransport,
} from "teleportal";
import { Document } from "teleportal/server";

function encode(message: Message, instanceId: string) {
  return encoding.encode((encoder) => {
    encoding.writeVarString(encoder, instanceId);
    encoding.writeVarString(encoder, Document.getDocumentId(message));
    encoding.writeUint8Array(encoder, message.encoded);
  });
}

function decode(message: Uint8Array) {
  const decoder = decoding.createDecoder(message);

  return {
    instanceId: decoding.readVarString(decoder),
    documentId: decoding.readVarString(decoder),
    message: decoding.readTailAsUint8Array(decoder),
  };
}
/**
 * Redis pub/sub transport for Y.js document synchronization.
 * This transport can be used for both client-server and server-server synchronization.
 */

/**
 * Multi-document Redis source that can handle multiple documents with a single connection
 */
export function getRedisSource<Context extends ServerContext>({
  context,
  redisOptions,
  keyPrefix = "",
  instanceId,
}: {
  context?: Context;
  redisOptions: {
    path: string;
    options?: RedisOptions;
  };
  keyPrefix?: string;
  instanceId: string;
}): YSource<
  Context,
  {
    sourceRedisClient: Redis;
    subscribe: (documentId: string) => Promise<void>;
    unsubscribe: (documentId: string) => Promise<void>;
  }
> {
  const redis = new Redis(redisOptions.path, redisOptions.options ?? {});
  const subscribedDocuments = new Set<string>();

  return {
    sourceRedisClient: redis,
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
        redis.on("messageBuffer", (channel, rawMessage) => {
          try {
            const message = decode(rawMessage);
            if (message.instanceId === instanceId) {
              // Skip this message since it was sent by the same instanceId
              return;
            }
            const decoded = decodeMessage(
              new Uint8Array(message.message) as BinaryMessage,
            );
            Object.assign(decoded.context, {
              ...context,
              clientId: "redis-" + instanceId,
              // derive the room name
              room: message.documentId.slice(
                0,
                -1 * (decoded.document.length + 1),
              ),
            });
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

/**
 * Multi-document Redis sink that can handle multiple documents with a single connection
 */
export function getRedisSink<Context extends ServerContext>({
  redisOptions,
  keyPrefix = "",
  instanceId,
}: {
  context?: Context;
  redisOptions: {
    path: string;
    options?: RedisOptions;
  };
  keyPrefix?: string;
  instanceId: string;
}): YSink<Context, { sinkRedisClient: Redis }> {
  const redis = new Redis(redisOptions.path, redisOptions.options ?? {});
  return {
    sinkRedisClient: redis,
    writable: new WritableStream({
      async write(chunk) {
        try {
          if (
            chunk.context.clientId &&
            chunk.context.clientId.startsWith("redis")
          ) {
            // skip redis originated messages to avoid loops
            return;
          }
          const channel = keyPrefix + Document.getDocumentId(chunk);

          await redis.publish(channel, Buffer.from(encode(chunk, instanceId)));
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

/**
 * Multi-document Redis transport that can handle multiple documents with shared connections
 */
export function getRedisTransport<Context extends ServerContext>({
  context,
  redisOptions,
  keyPrefix = "",
  instanceId = uuidv4(),
}: {
  context?: Context;
  redisOptions: {
    path: string;
    options?: RedisOptions;
  };
  keyPrefix?: string;
  instanceId?: string;
}): YTransport<
  Context,
  {
    sourceRedisClient: Redis;
    sinkRedisClient: Redis;
    subscribe: (documentId: string) => Promise<void>;
    unsubscribe: (documentId: string) => Promise<void>;
    close: () => Promise<void>;
  }
> {
  const source = getRedisSource({
    context,
    redisOptions,
    keyPrefix,
    instanceId,
  });
  const sink = getRedisSink({
    context,
    redisOptions,
    keyPrefix,
    instanceId,
  });

  return {
    ...compose(source, sink),
    close: async () => {
      await source.readable.cancel();
      await sink.writable.close();
    },
  };
}
