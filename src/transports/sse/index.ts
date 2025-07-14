import { fromBase64, toBase64 } from "lib0/buffer";
import {
  BinaryMessage,
  ClientContext,
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
      console.log("original", chunk.encoded);
      const payload = toBase64(chunk.encoded);
      const message = `event:message\nid:${chunk.id}\ndata: ${payload}\n\n`;
      console.log("writing sse", message);
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
export function getSSESource<Context extends ClientContext>(
  source: EventSource,
  context: Context,
): Source<
  Context,
  {
    close: () => void;
  }
> {
  const reader = getMessageReader(context);
  const writer = reader.writable.getWriter();

  const handler = (event: MessageEvent) => {
    console.log("event", event.data);
    const message = fromBase64(event.data) as BinaryMessage;
    console.log("reading sse", message);
    writer.write(message);
  };
  source.addEventListener("message", handler);
  return {
    readable: reader.readable,
    close: () => {
      source.removeEventListener("message", handler);
    },
  };
}
