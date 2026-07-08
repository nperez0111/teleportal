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
  return {
    ...sink,
    async write(message) {
      await sink.write(message);

      if (message.type !== "ack") {
        const ackMessage = new AckMessage(
          {
            type: "ack",
            messageId: message.id,
          },
          context,
        );
        await pubSub.publish(ackTopic, ackMessage.encoded, sourceId);
      }
    },
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
  const pendingAcks = new Map<
    string,
    {
      resolve: () => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  const messagesToAck = new Set<Promise<void>>();
  let unsubscribeAck: (() => Promise<void>) | null = null;
  let subscriptionReady = false;
  // Set once the sink is torn down (abort or unsubscribe). Distinct from a
  // per-message timeout: a timeout forgets just that message so later waits
  // aren't poisoned, but a terminal teardown means every subsequent
  // `waitForAcks()` should reject — the sink can no longer receive acks.
  let terminalError: Error | null = null;

  const setupAckSubscription = async () => {
    if (unsubscribeAck) return;

    unsubscribeAck = await pubSub.subscribe(ackTopic, (message, messageSourceId) => {
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
    });
    subscriptionReady = true;
  };

  if (abortSignal) {
    abortSignal.addEventListener("abort", () => {
      terminalError = new Error("Request aborted");
      for (const pending of pendingAcks.values()) {
        clearTimeout(pending.timeout);
        pending.reject(terminalError);
      }
      pendingAcks.clear();
      unsubscribeAck?.();
    });
  }

  // Eagerly start subscription
  const subscriptionPromise = setupAckSubscription();

  const trackedSink: Sink<Context, AdditionalProperties> = {
    ...sink,
    async write(message) {
      if (!subscriptionReady) await subscriptionPromise;

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
        messagesToAck.add(ackPromise);
        // Drop the tracked promise once it settles — whether it resolved (ack
        // received) or rejected (timeout/abort/unsubscribe). Leaving rejected
        // promises in the set both leaks memory on long-lived connections and
        // poisons every subsequent `waitForAcks()` (its `Promise.all` would
        // re-observe the stale rejection). The `.catch` here also marks the
        // rejection as handled so it never surfaces as an unhandled rejection;
        // real waiters still observe it via `waitForAcks()`.
        const forget = () => messagesToAck.delete(ackPromise);
        ackPromise.then(forget, forget);
      }

      await sink.write(message);
    },
  };

  return Object.assign(trackedSink, {
    waitForAcks: async () => {
      await subscriptionPromise;
      if (terminalError) throw terminalError;
      await Promise.all(messagesToAck);
    },
    unsubscribe: async () => {
      terminalError ??= new Error("Unsubscribed");
      for (const pending of pendingAcks.values()) {
        clearTimeout(pending.timeout);
        pending.reject(terminalError);
      }
      pendingAcks.clear();

      if (unsubscribeAck) {
        await unsubscribeAck();
        unsubscribeAck = null;
      }
    },
  });
}
