import { Redis, RedisOptions } from "ioredis";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { uuidv4 } from "lib0/random";
import {
  BinaryMessage,
  Message,
  PubSub,
  PubSubTopic,
  RawReceivedMessage,
  ServerContext,
  Transport,
} from "teleportal";
import { Document } from "teleportal/server";
import { getPubSubTransport } from "../pubsub";

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
  /**
   * A map of subscription IDs to unsubscribe functions
   */
  private subscriptions = new Map<string, () => Promise<void>>();

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
    const encoded = this.encodeMessage(message, sourceId);
    await this.publisherRedis.publish(topic, Buffer.from(encoded));
  }

  async subscribe(
    topic: PubSubTopic,
    callback: (message: BinaryMessage, sourceId: string) => void,
  ): Promise<() => Promise<void>> {
    const subscriptionId = uuidv4();
    await this.subscriberRedis.subscribe(topic);

    const messageHandler = (channel: string | Buffer, rawMessage: Buffer) => {
      const channelStr =
        typeof channel === "string" ? channel : channel.toString();

      if (channelStr === topic) {
        try {
          const decoded = this.decodeMessage(new Uint8Array(rawMessage));

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
      this.subscriptions.delete(subscriptionId);
    };

    this.subscriptions.set(subscriptionId, unsubscribe);
    this.subscribedTopics.set(
      topic,
      (this.subscribedTopics.get(topic) ?? 0) + 1,
    );
    return unsubscribe;
  }

  async destroy(): Promise<void> {
    // Unsubscribe from all topics
    await Promise.all(
      Array.from(this.subscriptions.values()).map((unsubscribe) =>
        unsubscribe(),
      ),
    );
    this.subscriptions.clear();
    await this.publisherRedis.quit();
    await this.subscriberRedis.quit();
  }

  private encodeMessage(message: BinaryMessage, sourceId: string) {
    return encoding.encode((encoder) => {
      encoding.writeVarString(encoder, sourceId);
      encoding.writeUint8Array(encoder, message);
    });
  }

  private decodeMessage(message: Uint8Array) {
    const decoder = decoding.createDecoder(message);

    const sourceId = decoding.readVarString(decoder);
    const decodedMessage = decoding.readTailAsUint8Array(
      decoder,
    ) as BinaryMessage;

    return {
      sourceId,
      message: decodedMessage,
    };
  }
}

/**
 * Multi-document Redis {@link Transport} that can handle multiple documents with shared connections
 */
export function getRedisTransport<Context extends ServerContext>({
  getContext,
  redisOptions,
  sourceId,
}: {
  getContext: Context | ((message: RawReceivedMessage) => Context);
  redisOptions: {
    path: string;
    options?: RedisOptions;
  };
  sourceId: string;
}): Transport<
  Context,
  {
    /**
     * The {@link PubSub} to use for consuming {@link Message}s.
     */
    pubsub: PubSub;
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
  const pubsub = new RedisPubSub(redisOptions);

  const topicResolver = (message: Message<ServerContext>): PubSubTopic => {
    return `document/${Document.getDocumentId(message)}`;
  };

  const transport = getPubSubTransport({
    getContext,
    pubsub,
    topicResolver,
    sourceId,
  });

  return {
    ...transport,
    close: async () => {
      try {
        await transport.readable.cancel();
      } catch (error) {
        // Stream might already be locked or closed
      }
      try {
        await transport.writable.close();
      } catch (error) {
        // Stream might already be locked or closed
      }
      await pubsub.destroy?.();
    },
  };
}
