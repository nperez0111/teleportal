import {
  type ClientContext,
  encodeMessageArray,
  type Message,
  type MessageArray,
  type Sink,
  type Source,
  decodeMessageArray,
} from "teleportal";
import { batch, consume, createChannel } from "../../lib/iter";
import type { BatchingOptions } from "../utils";

/**
 * Transport which receives a binary message from an HTTP request
 * It is single use, and will close the writer when the request is complete
 */
export function getHTTPSource<Context extends ClientContext>({
  context,
}: {
  /**
   * The {@link ClientContext} to use for reading {@link Message}s from the {@link Source}.
   */
  context: Context;
}): Source<
  Context,
  {
    handleHTTPRequest: (request: Request) => Promise<void>;
  }
> {
  const channel = createChannel<Message<Context>>();

  return {
    source: channel,
    handleHTTPRequest: async (request) => {
      const body = await request.arrayBuffer();
      const messageArray = new Uint8Array(body) as MessageArray;
      const messages = decodeMessageArray(messageArray);
      for (const msg of messages) {
        Object.assign(msg.context, context);
        channel.send(msg as Message<Context>);
      }
      channel.close();
    },
  };
}

/**
 * Transport which sends a single binary message as an HTTP request
 */
export function getHTTPSink<Context extends ClientContext>({
  request,
  context,
  batchingOptions,
}: {
  /**
   * A function that sends a {@link Message} as an HTTP request.
   */
  request: (ctx: {
    requestOptions: Pick<RequestInit, "method" | "headers" | "cache" | "body">;
  }) => Promise<void>;
  /**
   * The {@link ClientContext} to use for writing {@link Message}s to the {@link Sink}.
   */
  context: Context;
  /**
   * The {@link BatchingOptions} to use for the {@link Sink}.
   */
  batchingOptions?: BatchingOptions;
}): Sink<Context> {
  const { maxBatchSize = 10, maxBatchDelay = 100 } = batchingOptions ?? {};
  const channel = createChannel<Message<Context>>();

  // Drain the channel through the shared time/size batcher; each batch becomes
  // one POST. Failures drop their batch but keep the drain alive.
  void consume(
    batch(channel, { maxSize: maxBatchSize, maxDelayMs: maxBatchDelay }),
    async (messages) => {
      try {
        await request({
          requestOptions: {
            method: "POST",
            headers: {
              "Content-Type": "application/octet-stream",
              "x-powered-by": "teleportal",
              "x-teleportal-client-id": context.clientId,
            },
            cache: "no-store",
            body: encodeMessageArray(messages) as unknown as BodyInit,
          },
        });
      } catch {
        // Drop this batch; later writes still flow through the channel.
      }
    },
  );

  return {
    write(message: Message<Context>) {
      channel.trySend(message);
    },
    close() {
      channel.close();
    },
  };
}
