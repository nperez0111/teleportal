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
          await redis.publish(chunk.document, Buffer.from(chunk.encoded));
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
