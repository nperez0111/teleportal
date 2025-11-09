import {
  BinaryMessage,
  Message,
  PubSub,
  PubSubTopic,
  RawReceivedMessage,
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
  pubSub,
  topicResolver,
  sourceId,
}: {
  /**
   * The {@link PubSub} to use for publishing {@link Message}s.
   */
  pubSub: PubSub;
  /**
   * A function that resolves the topic for a given {@link Message}.
   */
  topicResolver: (message: Message<Context>) => PubSubTopic;
  /**
   * The source ID to use for publishing {@link Message}s.
   */
  sourceId: string;
}): Sink<
  Context,
  {
    /**
     * The {@link PubSub} to use for publishing {@link Message}s.
     */
    pubSub: PubSub;
  }
> {
  return {
    pubSub,
    writable: new WritableStream({
      async write(chunk) {
        const topic = topicResolver(chunk);
        await pubSub.publish(topic, chunk.encoded, sourceId);
      },
    }),
  };
}

/**
 * Generic consumer source that consumes messages from topics using the provided backend
 */
export function getPubSubSource<Context extends ServerContext>({
  getContext,
  pubSub,
  sourceId,
}: {
  /**
   * The {@link ServerContext} to use for reading {@link Message}s from the {@link Source}.
   */
  getContext: Context | ((message: RawReceivedMessage) => Context);
  /**
   * The {@link PubSub} to use for consuming {@link Message}s.
   */
  pubSub: PubSub;
  /**
   * The source ID to use for consuming {@link Message}s.
   *
   * This will skip messages from the same source.
   */
  sourceId: string;
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
    pubSub: PubSub;
  }
> {
  const subscribedTopics = new Map<PubSubTopic, () => Promise<void>>();
  let controller: ReadableStreamDefaultController<BinaryMessage>;

  return {
    pubSub,
    async subscribe(topic) {
      if (!subscribedTopics.has(topic)) {
        const unsubscribe = await pubSub.subscribe(
          topic,
          (message, messageSourceId) => {
            if (messageSourceId === sourceId) {
              return;
            }
            controller.enqueue(message);
          },
        );
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
    }).pipeThrough(getMessageReader(getContext)),
  };
}

/**
 * Create a generic pub/sub transport that can work with any backend implementation
 */
export function getPubSubTransport<Context extends ServerContext>({
  getContext,
  pubSub,
  topicResolver,
  sourceId,
}: {
  /**
   * The {@link ServerContext} to use for reading {@link Message}s from the {@link Source}.
   */
  getContext: Context | ((message: RawReceivedMessage) => Context);
  /**
   * The {@link PubSub} to use for consuming {@link Message}s.
   */
  pubSub: PubSub;
  /**
   * A function that resolves the topic for a given {@link Message}.
   */
  topicResolver: (message: Message<Context>) => PubSubTopic;
  /**
   * The source ID to use for publishing {@link Message}s.
   */
  sourceId: string;
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
    pubSub: PubSub;
  }
> {
  const transport = compose(
    getPubSubSource({
      getContext,
      pubSub,
      sourceId,
    }),
    getPubSubSink({
      pubSub,
      topicResolver,
      sourceId,
    }),
  );

  return transport;
}
