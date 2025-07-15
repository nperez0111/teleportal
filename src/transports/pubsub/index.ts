import {
  BinaryMessage,
  Message,
  ServerContext,
  Sink,
  Source,
  Observable,
} from "teleportal";
import { getMessageReader } from "../utils";

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
  onError,
}: {
  backend: PubSubBackend;
  topicResolver: (message: Message<Context>) => string;
  onError?: (error: Error) => void;
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
        backend.close().catch(console.error);
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
  }>;
}): Source<
  Context,
  {
    backend: PubSubBackend;
    observer: Observable<{
      subscribe: (topic: string) => void;
      unsubscribe: (topic: string) => void;
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
        observer.destroy();
        // Unsubscribe from all topics
        for (const topic of Array.from(subscribedTopics.keys())) {
          const unsubscribe = subscribedTopics.get(topic);
          if (unsubscribe) {
            try {
              await unsubscribe();
            } catch (error) {
              console.error(`Error unsubscribing from topic ${topic}:`, error);
            }
          }
        }
        subscribedTopics.clear();

        await backend.close();
      },
    }).pipeThrough(reader),
  };
}

/**
 * Simple in-memory pub/sub backend implementation for testing/development
 */
export class InMemoryPubSubBackend implements PubSubBackend {
  private subscribers = new Map<
    string,
    Set<(message: BinaryMessage) => void>
  >();

  async publish(topic: string, message: BinaryMessage): Promise<void> {
    const callbacks = this.subscribers.get(topic);
    if (callbacks) {
      for (const callback of Array.from(callbacks)) {
        try {
          callback(message);
        } catch (error) {
          console.error("Error in subscriber callback:", error);
        }
      }
    }
  }

  async subscribe(
    topic: string,
    callback: (message: BinaryMessage) => void,
  ): Promise<() => Promise<void>> {
    if (!this.subscribers.has(topic)) {
      this.subscribers.set(topic, new Set());
    }

    const callbacks = this.subscribers.get(topic)!;
    callbacks.add(callback);

    // Return unsubscribe function
    return async () => {
      callbacks.delete(callback);
      if (callbacks.size === 0) {
        this.subscribers.delete(topic);
      }
    };
  }

  async close(): Promise<void> {
    this.subscribers.clear();
  }
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
  const source = getPubSubSource({
    context,
    backend,
    observer,
  });

  const sink = getPubSubSink({
    backend,
    topicResolver,
  });

  return {
    ...source,
    ...sink,
    readable: source.readable,
    writable: sink.writable,
    close: async () => {
      await source.readable.cancel();
      await sink.writable.close();
    },
  };
}
