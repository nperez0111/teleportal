import {
  BinaryMessage,
  Message,
  ServerContext,
  Sink,
  Source,
  PubSub,
  Transport,
  decodeMessage,
  ClientContext,
} from "teleportal";
import { compose, getMessageReader } from "../utils";

/**
 * Generic publisher sink that publishes messages to a topic using the provided backend
 */
export function getPubSubSink<Context extends ServerContext>({
  pubsub,
  topicResolver,
}: {
  /**
   * The {@link PubSub} to use for publishing {@link Message}s.
   */
  pubsub: PubSub;
  /**
   * A function that resolves the topic for a given {@link Message}.
   */
  topicResolver: (message: Message<Context>) => string;
}): Sink<Context> {
  return {
    writable: new WritableStream({
      async write(chunk) {
        const topic = topicResolver(chunk);
        await pubsub.publish(topic, chunk.encoded);
      },
    }),
  };
}

/**
 * Generic consumer source that consumes messages from topics using the provided backend
 */
export function getPubSubSource<Context extends ClientContext>({
  context,
  pubsub,
}: {
  /**
   * The {@link ClientContext} to use for reading {@link Message}s from the {@link Source}.
   */
  context: Context;
  /**
   * The {@link PubSub} to use for consuming {@link Message}s.
   */
  pubsub: PubSub;
}): Source<
  Context,
  {
    /**
     * Subscribe to a topic
     */
    subscribe: (topic: string) => Promise<void>;
    /**
     * Unsubscribe from a topic, if no topic is provided, unsubscribe from all topics
     */
    unsubscribe: (topic?: string) => Promise<void>;
  }
> {
  const subscribedTopics = new Map<string, () => Promise<void>>();
  const reader = getMessageReader(context);
  let controller: ReadableStreamDefaultController<BinaryMessage>;

  return {
    async subscribe(topic) {
      if (!subscribedTopics.has(topic)) {
        const unsubscribe = await pubsub.subscribe(topic, (message) => {
          controller.enqueue(message);
        });
        subscribedTopics.set(topic, unsubscribe);
      }
    },
    async unsubscribe(topic) {
      if (topic === undefined) {
        await Promise.all(
          Array.from(subscribedTopics.values()).map((unsubscribe) =>
            unsubscribe(),
          ),
        );
        subscribedTopics.clear();
        return;
      }
      const unsubscribe = subscribedTopics.get(topic);
      if (unsubscribe) {
        await unsubscribe();
        subscribedTopics.delete(topic);
      }
    },
    readable: new ReadableStream<BinaryMessage>({
      async start(_controller) {
        controller = _controller;
      },
      async cancel() {
        await Promise.all(
          Array.from(subscribedTopics.values()).map((unsubscribe) =>
            unsubscribe(),
          ),
        );
        subscribedTopics.clear();
      },
    }).pipeThrough(reader),
  };
}

/**
 * Create a generic pub/sub transport that can work with any backend implementation
 */
export function getPubSubTransport<Context extends ServerContext>({
  context,
  pubsub,
  topicResolver,
}: {
  /**
   * The {@link ClientContext} to use for reading {@link Message}s from the {@link Source}.
   */
  context: Context;
  /**
   * The {@link PubSub} to use for consuming {@link Message}s.
   */
  pubsub: PubSub;
  /**
   * A function that resolves the topic for a given {@link Message}.
   */
  topicResolver: (message: Message<Context>) => string;
}): Transport<
  Context,
  {
    /**
     * Subscribe to a topic
     */
    subscribe: (topic: string) => Promise<void>;
    /**
     * Unsubscribe from a topic, if no topic is provided, unsubscribe from all topics
     */
    unsubscribe: (topic?: string) => Promise<void>;
  }
> {
  const transport = compose(
    getPubSubSource({
      context,
      pubsub,
    }),
    getPubSubSink({
      pubsub,
      topicResolver,
    }),
  );

  return transport;
}
