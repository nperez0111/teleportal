import {
  type ClientContext,
  encodeMessageArray,
  type Message,
  type Sink,
  type Source,
} from "teleportal";
import { fromMessageArrayStream } from "../utils";

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
  const transform = new TransformStream<Message, Message>();
  return {
    readable: transform.readable,
    handleHTTPRequest: async (request) => {
      await request
        .body!.pipeThrough(fromMessageArrayStream(context))
        .pipeTo(transform.writable);
      return;
    },
  };
}

/**
 * Transport which sends a single binary message as an HTTP request
 */
export function getHTTPSink<Context extends ClientContext>({
  request,
  context,
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
}): Sink<Context> {
  return {
    writable: new WritableStream({
      async write(chunk) {
        await request({
          requestOptions: {
            method: "POST",
            headers: {
              "Content-Type": "application/octet-stream",
              "x-powered-by": "teleportal",
              "x-teleportal-client-id": context.clientId,
            },
            cache: "no-store",
            // TODO can implement batching of requests in the future
            body: encodeMessageArray([chunk]),
          },
        });
      },
    }),
  };
}
