import { fromBase64, toBase64 } from "lib0/buffer";
import {
  BinaryMessage,
  ClientContext,
  isBinaryMessage,
  Message,
  Sink,
  Source,
} from "teleportal";
import { getMessageReader } from "../utils";

/**
 * Transport which transforms messages into SSE messages
 */
export function getSSESink<Context extends ClientContext>({
  context,
}: {
  context?: Context;
} = {}): Sink<
  Context,
  {
    sseResponse: Response;
  }
> {
  const transform = new TransformStream<Message<any>, string>({
    transform(chunk, controller) {
      // TODO probably a better encoding for sse
      const payload = toBase64(chunk.encoded);
      const message = `event:message\nid:${chunk.id}\ndata: ${payload}\n\n`;
      controller.enqueue(message);
    },
  });
  return {
    writable: transform.writable,
    sseResponse: new Response(transform.readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control":
          "private, no-cache, no-store, no-transform, must-revalidate, max-age=0",
        "x-accel-buffering": "no",
        "x-powered-by": "teleportal",
        "x-teleportal-client-id": context?.clientId ?? "",
      },
    }),
  };
}

/**
 * Transport which transforms SSE messages into messages
 */
export function getSSESource<Context extends ClientContext>({
  source,
  context,
}: {
  source: EventSource;
  context: Context;
}): Source<Context> {
  let handler: (event: MessageEvent) => void;

  return {
    readable: new ReadableStream<BinaryMessage>({
      start(controller) {
        handler = (event: MessageEvent) => {
          const message = fromBase64(event.data);

          if (isBinaryMessage(message)) {
            controller.enqueue(message);
          }
        };
        source.addEventListener("message", handler);
      },
      cancel() {
        source.removeEventListener("message", handler);
      },
    }).pipeThrough(getMessageReader(context)),
  };
}
