import {
  BinaryMessage,
  Message,
  ServerContext,
  Sink,
  Source,
  Observable,
} from "teleportal";
import { compose, getMessageReader } from "../utils";

export { InMemoryPubSubBackend } from "./in-memory";

/**
 * Generic interface for a pub/sub backend implementation.
 * Can be implemented by in-memory queues, Redis, or any other pub/sub system.
 */
export interface PubSubBackend {
  /**
   * Publish a message to a topic/channel
   */
  publish(topic: string, message: BinaryMessage): Promise<void>;

  /**
   * Subscribe to a topic/channel and receive messages
   * @param topic - The topic to subscribe to
   * @param callback - Function called when a message is received
   * @returns A function to unsubscribe
   */
  subscribe(
    topic: string,
    callback: (message: BinaryMessage) => void,
  ): Promise<() => Promise<void>>;

  /**
   * Close/cleanup the backend connection
   */
  close(): Promise<void>;
}

/**
 * Generic publisher sink that publishes messages to a topic using the provided backend
 */
export function getPubSubSink<Context extends ServerContext>({
  backend,
  topicResolver,
}: {
  backend: PubSubBackend;
  topicResolver: (message: Message<Context>) => string;
}): Sink<Context, { backend: PubSubBackend }> {
  return {
    backend,
    writable: new WritableStream({
      async write(chunk) {
        const topic = topicResolver(chunk);
        await backend.publish(topic, chunk.encoded);
      },
      async close() {
        await backend.close();
      },
      async abort() {
        await backend.close();
      },
    }),
  };
}

/**
 * Generic consumer source that consumes messages from topics using the provided backend
 */
export function getPubSubSource<Context extends ServerContext>({
  context,
  backend,
  observer,
}: {
  context?: Context;
  backend: PubSubBackend;
  observer: Observable<{
    subscribe: (topic: string) => void;
    unsubscribe: (topic: string) => void;
    destroy: () => void;
  }>;
}): Source<
  Context,
  {
    backend: PubSubBackend;
    observer: Observable<{
      subscribe: (topic: string) => void;
      unsubscribe: (topic: string) => void;
      destroy: () => void;
    }>;
  }
> {
  const subscribedTopics = new Map<string, () => Promise<void>>();
  const reader = getMessageReader(context || ({} as Context));

  observer.on("unsubscribe", async (topic: string) => {
    const unsubscribe = subscribedTopics.get(topic);
    if (unsubscribe) {
      await unsubscribe();
      subscribedTopics.delete(topic);
    }
  });

  return {
    backend,
    observer,
    readable: new ReadableStream({
      async start(controller) {
        observer.on("subscribe", async (topic: string) => {
          if (!subscribedTopics.has(topic)) {
            const unsubscribe = await backend.subscribe(topic, (message) => {
              controller.enqueue(message);
            });
            subscribedTopics.set(topic, unsubscribe);
          }
        });
      },
      async cancel() {
        await observer.call("destroy");
        subscribedTopics.clear();

        await backend.close();
      },
    }).pipeThrough(reader),
  };
}

/**
 * Create a generic pub/sub transport that can work with any backend implementation
 */
export function getPubSubTransport<Context extends ServerContext>({
  context,
  backend,
  topicResolver,
  observer,
}: {
  context?: Context;
  backend: PubSubBackend;
  topicResolver: (message: Message<Context>) => string;
  observer: Observable<{
    subscribe: (topic: string) => void;
    unsubscribe: (topic: string) => void;
  }>;
}) {
  const transport = compose(
    getPubSubSource({
      context,
      backend,
      observer,
    }),
    getPubSubSink({
      backend,
      topicResolver,
    }),
  );

  return transport;
}
