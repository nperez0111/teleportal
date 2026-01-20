import {
  AckMessage,
  decodeMessage,
  type PubSub,
  type PubSubTopic,
  type ServerContext,
  type Sink,
} from "teleportal";

/**
 * Wraps a {@link Sink} to automatically send ACK messages after messages are written.
 * ACK messages are published to the specified PubSub topic.
 *
 * @param sink - The sink to wrap.
 * @param options - Options for ACK handling.
 * @returns A new sink that sends ACKs after writing messages.
 */
export function withAckSink<
  Context extends ServerContext,
  AdditionalProperties extends Record<string, unknown>,
>(
  sink: Sink<Context, AdditionalProperties>,
  {
    pubSub,
    ackTopic,
    sourceId,
    context,
  }: {
    /**
     * The {@link PubSub} to use for publishing ACK messages.
     */
    pubSub: PubSub;
    /**
     * The topic to publish ACK messages to.
     */
    ackTopic: PubSubTopic;
    /**
     * The source ID to use when publishing ACK messages.
     */
    sourceId: string;
    /**
     * The context to use for creating ACK messages.
     */
    context: Context;
  },
): Sink<Context, AdditionalProperties> {
  const writer = sink.writable.getWriter();

  return {
    ...sink,
    writable: new WritableStream({
      async write(message) {
        // Write to the underlying sink
        await writer.write(message);

        // Send ACK for non-ACK messages (to avoid ACK loops)
        if (message.type !== "ack") {
          const ackMessage = new AckMessage(
            {
              type: "ack",
              messageId: message.id,
            },
            context,
          );

          // Publish ACK to the ACK topic
          await pubSub.publish(ackTopic, ackMessage.encoded, sourceId);
        }
      },
      async close() {
        try {
          await writer.close();
        } finally {
          try {
            writer.releaseLock();
          } catch (error) {
            // Ignore errors when releasing lock (it might already be released)
          }
        }
      },
      async abort(reason) {
        try {
          await writer.abort(reason);
        } finally {
          try {
            writer.releaseLock();
          } catch (error) {
            // Ignore errors when releasing lock (it might already be released)
          }
        }
      },
    }),
  };
}

/**
 * Wraps a {@link Sink} to track messages and wait for ACK messages.
 * Messages written to the sink are tracked, and you can wait for all ACKs using the sink's {@link waitForAcks} method.
 *
 * @param sink - The sink to wrap.
 * @param options - Options for ACK tracking.
 * @returns A wrapped sink with {@link waitForAcks} and {@link unsubscribe} methods attached.
 */
export function withAckTrackingSink<
  Context extends ServerContext,
  AdditionalProperties extends Record<string, unknown>,
>(
  sink: Sink<Context, AdditionalProperties>,
  {
    pubSub,
    ackTopic,
    sourceId,
    ackTimeout = 10000,
    abortSignal,
  }: {
    /**
     * The {@link PubSub} to use for subscribing to ACK messages.
     */
    pubSub: PubSub;
    /**
     * The topic to subscribe to for ACK messages.
     */
    ackTopic: PubSubTopic;
    /**
     * The source ID to use when subscribing to ACK messages.
     */
    sourceId: string;
    /**
     * Timeout in milliseconds for waiting for ACKs. Defaults to 10000ms (10 seconds).
     */
    ackTimeout?: number;
    /**
     * Optional abort signal to cancel ACK tracking.
     */
    abortSignal?: AbortSignal;
  },
): Sink<
  Context,
  AdditionalProperties & {
    /**
     * Promise that resolves when all tracked messages have been ACKed.
     * Rejects if any message times out or if the abort signal is triggered.
     */
    waitForAcks: () => Promise<void>;
    /**
     * Unsubscribe from ACK messages.
     */
    unsubscribe: () => Promise<void>;
  }
> {
  // Track pending messages waiting for ACKs
  const pendingAcks = new Map<
    string,
    {
      resolve: () => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  // Track messages that need ACKs
  const messagesToAck: Promise<void>[] = [];

  // Subscribe to ACK topic
  let unsubscribeAck: (() => Promise<void>) | null = null;

  const setupAckSubscription = async () => {
    if (unsubscribeAck) return;

    unsubscribeAck = await pubSub.subscribe(
      ackTopic,
      (message, messageSourceId) => {
        // Ignore messages from the same source to avoid processing our own ACKs
        if (messageSourceId === sourceId) {
          return;
        }

        const decoded = decodeMessage(message);
        if (decoded instanceof AckMessage) {
          const messageId = decoded.payload.messageId;
          const pending = pendingAcks.get(messageId);
          if (pending) {
            clearTimeout(pending.timeout);
            pending.resolve();
            pendingAcks.delete(messageId);
          }
        }
      },
    );
  };

  // Set up abort handler
  if (abortSignal) {
    abortSignal.addEventListener("abort", () => {
      // Reject all pending ACKs
      for (const pending of pendingAcks.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("Request aborted"));
      }
      pendingAcks.clear();
      unsubscribeAck?.();
    });
  }

  // Wrap the sink to track messages that need ACKs
  const writer = sink.writable.getWriter();
  const trackedSink: Sink<Context, AdditionalProperties> = {
    ...sink,
    writable: new WritableStream({
      async start() {
        await setupAckSubscription();
      },
      async write(message) {
        // Track non-ACK messages for ACK waiting
        if (message.type !== "ack") {
          const ackPromise = new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
              pendingAcks.delete(message.id);
              reject(new Error(`ACK timeout for message ${message.id}`));
            }, ackTimeout);

            pendingAcks.set(message.id, {
              resolve: () => {
                clearTimeout(timeout);
                resolve();
              },
              reject: (error) => {
                clearTimeout(timeout);
                reject(error);
              },
              timeout,
            });
          });

          messagesToAck.push(ackPromise);
        }

        // Write to the underlying sink
        await writer.write(message);
      },
      async close() {
        try {
          await writer.close();
        } finally {
          try {
            writer.releaseLock();
          } catch (error) {
            // Ignore errors when releasing lock (it might already be released)
          }
        }
      },
      async abort(reason) {
        try {
          await writer.abort(reason);
        } finally {
          try {
            writer.releaseLock();
          } catch (error) {
            // Ignore errors when releasing lock (it might already be released)
          }
        }
      },
    }),
  };

  return Object.assign(trackedSink, {
    waitForAcks: async () => {
      await setupAckSubscription();
      await Promise.all(messagesToAck);
    },
    unsubscribe: async () => {
      // Clean up remaining pending ACKs
      for (const pending of pendingAcks.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("Unsubscribed"));
      }
      pendingAcks.clear();

      if (unsubscribeAck) {
        await unsubscribeAck();
        unsubscribeAck = null;
      }
    },
  });
}
