import { Redis, RedisOptions } from "ioredis";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { uuidv4 } from "lib0/random";
import {
  BinaryMessage,
  decodeMessage,
  Message,
  PubSub,
  PubSubTopic,
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
  private instanceId: string;
  private subscriptions = new Map<string, () => Promise<void>>();

  constructor(
    redisOptions: { path: string; options?: RedisOptions },
    instanceId: string,
  ) {
    // Use separate connections for publishing and subscribing
    this.publisherRedis = new Redis(
      redisOptions.path,
      redisOptions.options ?? {},
    );
    this.subscriberRedis = new Redis(
      redisOptions.path,
      redisOptions.options ?? {},
    );
    this.instanceId = instanceId;
  }

  async publish(topic: PubSubTopic, message: BinaryMessage): Promise<void> {
    console.log(
      this.instanceId,
      "publishing to",
      topic,
      decodeMessage(message).id,
    );
    // Encode the message with instance ID to avoid loops
    const encoded = this.encodeMessage(message);
    await this.publisherRedis.publish(topic, Buffer.from(encoded));
  }

  async subscribe(
    topic: PubSubTopic,
    callback: (message: BinaryMessage) => void,
  ): Promise<() => Promise<void>> {
    // If already subscribed, return existing unsubscribe function
    if (this.subscriptions.has(topic)) {
      return this.subscriptions.get(topic)!;
    }

    console.log(this.instanceId, "subscribing to", topic);
    await this.subscriberRedis.subscribe(topic);

    const messageHandler = (channel: string | Buffer, rawMessage: Buffer) => {
      const channelStr =
        typeof channel === "string" ? channel : channel.toString();
      const msg = this.decodeMessage(new Uint8Array(rawMessage));
      console.log(
        this.instanceId,
        "received message on",
        channelStr,
        "from",
        msg.instanceId,
        "with message",
        decodeMessage(msg.message).id,
      );
      if (channelStr === topic) {
        try {
          const decoded = this.decodeMessage(new Uint8Array(rawMessage));
          if (decoded.instanceId === this.instanceId) {
            // Skip messages from this instance to avoid loops
            return;
          }
          callback(decoded.message);
        } catch (error) {
          console.error("Error decoding Redis message:", error);
        }
      }
    };

    this.subscriberRedis.on("messageBuffer", messageHandler);

    const unsubscribe = async (): Promise<void> => {
      this.subscriberRedis.off("messageBuffer", messageHandler);
      await this.subscriberRedis.unsubscribe(topic);
      this.subscriptions.delete(topic);
    };

    this.subscriptions.set(topic, unsubscribe);
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

  private encodeMessage(message: BinaryMessage) {
    return encoding.encode((encoder) => {
      encoding.writeVarString(encoder, this.instanceId);
      encoding.writeUint8Array(encoder, message);
    });
  }

  private decodeMessage(message: Uint8Array) {
    const decoder = decoding.createDecoder(message);

    const instanceId = decoding.readVarString(decoder);
    const decodedMessage = decoding.readTailAsUint8Array(
      decoder,
    ) as BinaryMessage;

    return {
      instanceId,
      message: decodedMessage,
    };
  }
}

/**
 * Multi-document Redis {@link Transport} that can handle multiple documents with shared connections
 */
export function getRedisTransport<Context extends ServerContext>({
  context,
  redisOptions,
  instanceId = uuidv4(),
}: {
  context: Context;
  redisOptions: {
    path: string;
    options?: RedisOptions;
  };
  instanceId?: string;
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
  const pubsub = new RedisPubSub(redisOptions, instanceId);

  const topicResolver = (message: Message<Context>): PubSubTopic => {
    return `document/${Document.getDocumentId(message)}`;
  };

  const transport = getPubSubTransport({
    context,
    pubsub,
    topicResolver,
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
