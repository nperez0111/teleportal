import { fromBase64, toBase64 } from "lib0/buffer";
import {
  BinaryMessage,
  ClientContext,
  encodePingMessage,
  isBinaryMessage,
  isPingMessage,
  Message,
  Sink,
  Source,
} from "teleportal";
import { getMessageReader } from "../utils";

/**
 * {@link Sink} which transforms {@link Message}s into SSE messages
 */
export function getSSESink<Context extends ClientContext>({
  context,
}: {
  /**
   * The {@link ClientContext} to use for writing {@link Message}s to the {@link Sink}.
   */
  context: Context;
}): Sink<
  Context,
  {
    /**
     * The {@link Response} to send to the client.
     */
    sseResponse: Response;
  }
> {
  let interval: ReturnType<typeof setInterval>;
  const transform = new TransformStream<Message<any>, string>({
    start(controller) {
      if (context.clientId) {
        controller.enqueue(
          `event:client-id\nid:client-id\ndata: ${context.clientId}\n\n`,
        );
      }

      interval = setInterval(() => {
        try {
          controller.enqueue(
            `event:ping\nid:ping\ndata: ${toBase64(encodePingMessage())}\n\n`,
          );
        } catch (error) {
          clearInterval(interval);
        }
      }, 5000);
    },
    transform(chunk, controller) {
      const payload = toBase64(chunk.encoded);
      const message = `event:message\nid:${chunk.id}\ndata: ${payload}\n\n`;
      controller.enqueue(message);
    },
    flush() {
      clearInterval(interval);
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
 * {@link Source} which transforms SSE messages into {@link Message}s
 */
export function getSSESource<Context extends ClientContext>({
  source,
  context,
  onPing,
}: {
  /**
   * The {@link EventSource} to listen to for SSE messages.
   */
  source: EventSource;
  /**
   * The {@link ClientContext} to use for reading {@link Message}s from the {@link Source}.
   */
  context: Context;
  onPing?: () => void;
}): Source<
  Context,
  {
    /**
     * The first message an SSE sends is it's {@link ClientContext.clientId},
     * so this tells you that the SSE is ready and can be used.
     */
    clientId: Promise<string>;
    /**
     * The {@link EventSource} that is being listened to.
     */
    eventSource: EventSource;
  }
> {
  let handler: (event: MessageEvent) => void;

  const clientId = new Promise<string>((resolve) => {
    source.addEventListener("client-id", (ev) => {
      resolve(ev.data);
    });
  });
  return {
    eventSource: source,
    clientId,
    readable: new ReadableStream<BinaryMessage>({
      start(controller) {
        handler = (event: MessageEvent) => {
          const message = fromBase64(event.data);

          if (isPingMessage(message)) {
            onPing?.();
            return;
          }

          if (isBinaryMessage(message)) {
            controller.enqueue(message);
          }
        };
        source.addEventListener("message", handler);
        source.addEventListener("ping", handler);
        source.addEventListener("error", (e) => {
          controller.error(e);
        });

        const interval = setInterval(() => {
          if (source.readyState === source.CLOSED) {
            clearInterval(interval);
            try {
              controller.close();
            } catch (e) {
              // ignore if we can't close, it may have already been cancelled
            }
          }
        }, 3000);
      },
      cancel() {
        source.close();
      },
    }).pipeThrough(getMessageReader(context)),
  };
}
