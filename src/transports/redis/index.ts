import { Redis, RedisOptions } from "ioredis";
import {
  BinaryMessage,
  decodePubSubMessage,
  encodePubSubMessage,
  Message,
  PubSub,
  PubSubTopic,
  RawReceivedMessage,
  ServerContext,
  Transport,
} from "teleportal";
import { getPubSubTransport } from "../pubSub";

export { RedisRateLimitStorage } from "./rate-limit-storage";

/**
 * Redis implementation of the {@link PubSub} interface
 */
export class RedisPubSub implements PubSub {
  private publisherRedis: Redis;
  private subscriberRedis: Redis;
  /**
   * A map of topics to the number of subscribers
   */
  private subscribedTopics = new Map<PubSubTopic, number>();

  // TODO instead of actually creating the two connections, we could just have a callback that gives us a connection
  // So we don't have to actually bundle in the redis client. See the NATS transport for an example.
  constructor(redisOptions: { path: string; options?: RedisOptions }) {
    // Use separate connections for publishing and subscribing
    this.publisherRedis = new Redis(
      redisOptions.path,
      redisOptions.options ?? {},
    );
    this.subscriberRedis = new Redis(
      redisOptions.path,
      redisOptions.options ?? {},
    );
  }

  async publish(
    topic: PubSubTopic,
    message: BinaryMessage,
    sourceId: string,
  ): Promise<void> {
    // Encode the message with instance ID to avoid loops
    const encoded = encodePubSubMessage(message, sourceId);
    await this.publisherRedis.publish(topic, Buffer.from(encoded));
  }

  async subscribe(
    topic: PubSubTopic,
    callback: (message: BinaryMessage, sourceId: string) => void,
  ): Promise<() => Promise<void>> {
    await this.subscriberRedis.subscribe(topic);

    const messageHandler = (channel: string | Buffer, rawMessage: Buffer) => {
      const channelStr =
        typeof channel === "string" ? channel : channel.toString();

      if (channelStr === topic) {
        try {
          const decoded = decodePubSubMessage(new Uint8Array(rawMessage));

          callback(decoded.message, decoded.sourceId);
        } catch (error) {
          console.error("Error decoding Redis message:", error);
        }
      }
    };

    this.subscriberRedis.on("messageBuffer", messageHandler);

    const unsubscribe = async (): Promise<void> => {
      this.subscriberRedis.off("messageBuffer", messageHandler);
      this.subscribedTopics.set(
        topic,
        (this.subscribedTopics.get(topic) ?? 0) - 1,
      );
      if ((this.subscribedTopics.get(topic) ?? 0) <= 0) {
        await this.subscriberRedis.unsubscribe(topic);
      }
    };

    this.subscribedTopics.set(
      topic,
      (this.subscribedTopics.get(topic) ?? 0) + 1,
    );
    return unsubscribe;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.publisherRedis.quit();
    await this.subscriberRedis.quit();
  }
}

/**
 * Multi-document Redis {@link Transport} that can handle multiple documents with shared connections
 */
export function getRedisTransport<Context extends ServerContext>({
  getContext,
  redisOptions,
  sourceId,
  topicResolver = (m) => `document/${m.document}`,
}: {
  getContext: Context | ((message: RawReceivedMessage) => Context);
  redisOptions: {
    path: string;
    options?: RedisOptions;
  };
  sourceId: string;
  topicResolver?: (message: Message<Context>) => PubSubTopic;
}): Transport<
  Context,
  {
    /**
     * The {@link PubSub} to use for consuming {@link Message}s.
     */
    pubSub: PubSub;
    /**
     * Subscribe to a topic
     */
    subscribe: (topic: PubSubTopic) => Promise<void>;
    /**
     * Unsubscribe from a topic, if no topic is provided, unsubscribe from all topics
     */
    unsubscribe: (topic?: PubSubTopic) => Promise<void>;
    /**
     * Close the transport
     */
    close: () => Promise<void>;
  }
> {
  const pubSub = new RedisPubSub(redisOptions);

  const transport = getPubSubTransport({
    getContext,
    pubSub,
    topicResolver,
    sourceId,
  });

  return {
    ...transport,
    close: async () => {
      try {
        await transport.readable.cancel();
      } catch {
        // Stream might already be locked or closed
      }
      try {
        await transport.writable.close();
      } catch {
        // Stream might already be locked or closed
      }
      await pubSub[Symbol.asyncDispose]?.();
    },
  };
}
