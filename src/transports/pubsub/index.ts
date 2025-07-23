import {
  BinaryMessage,
  Message,
  PubSub,
  PubSubTopic,
  ServerContext,
  Sink,
  Source,
  Transport,
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
  topicResolver: (message: Message<Context>) => PubSubTopic;
}): Sink<
  Context,
  {
    /**
     * The {@link PubSub} to use for publishing {@link Message}s.
     */
    pubsub: PubSub;
  }
> {
  return {
    pubsub,
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
export function getPubSubSource<Context extends ServerContext>({
  context,
  pubsub,
}: {
  /**
   * The {@link ServerContext} to use for reading {@link Message}s from the {@link Source}.
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
    subscribe: (topic: PubSubTopic) => Promise<void>;
    /**
     * Unsubscribe from a topic, if no topic is provided, unsubscribe from all topics
     */
    unsubscribe: (topic?: PubSubTopic) => Promise<void>;
    /**
     * The {@link PubSub} to use for consuming {@link Message}s.
     */
    pubsub: PubSub;
  }
> {
  const subscribedTopics = new Map<PubSubTopic, () => Promise<void>>();
  // TODO this could probably be a getContext method instead of having to pass in the context
  const reader = getMessageReader(context);
  let controller: ReadableStreamDefaultController<BinaryMessage>;

  return {
    pubsub,
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
   * The {@link ServerContext} to use for reading {@link Message}s from the {@link Source}.
   */
  context: Context;
  /**
   * The {@link PubSub} to use for consuming {@link Message}s.
   */
  pubsub: PubSub;
  /**
   * A function that resolves the topic for a given {@link Message}.
   */
  topicResolver: (message: Message<Context>) => PubSubTopic;
}): Transport<
  Context,
  {
    /**
     * Subscribe to a topic
     */
    subscribe: (topic: PubSubTopic) => Promise<void>;
    /**
     * Unsubscribe from a topic, if no topic is provided, unsubscribe from all topics
     */
    unsubscribe: (topic?: PubSubTopic) => Promise<void>;
    /**
     * The {@link PubSub} to use for consuming {@link Message}s.
     */
    pubsub: PubSub;
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
