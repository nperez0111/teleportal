import { fromBase64, toBase64 } from "teleportal/utils";
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
import { createChannel, toReadableStream } from "../../lib/iter";
import { decodeMessages } from "../utils";

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
  // Frames are sent as UTF-8 bytes rather than strings because some runtimes
  // (Cloudflare workerd) reject string chunks in Response bodies.
  const encoder = new TextEncoder();
  const channel = createChannel<Uint8Array>();

  // Send client ID as first event
  if (context.clientId) {
    channel.send(encoder.encode(`event:client-id\nid:client-id\ndata: ${context.clientId}\n\n`));
  }

  // Send periodic pings; stop once the channel no longer accepts them.
  const interval = setInterval(() => {
    if (
      !channel.trySend(
        encoder.encode(`event:ping\nid:ping\ndata: ${toBase64(encodePingMessage())}\n\n`),
      )
    ) {
      clearInterval(interval);
    }
  }, 5000);

  // Convert channel to ReadableStream for SSE Response
  const readable = toReadableStream<Uint8Array>(channel);

  return {
    write(message: Message<Context>) {
      const payload = toBase64(message.encoded);
      const event = `event:message\nid:${message.id}\ndata: ${payload}\n\n`;
      if (!channel.trySend(encoder.encode(event))) clearInterval(interval);
    },
    close() {
      clearInterval(interval);
      channel.close();
    },
    sseResponse: new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "private, no-cache, no-store, no-transform, must-revalidate, max-age=0",
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
     * The first message an SSE sends is it's {@link ClientContext['clientId']},
     * so this tells you that the SSE is ready and can be used.
     */
    clientId: Promise<string>;
    /**
     * The {@link EventSource} that is being listened to.
     */
    eventSource: EventSource;
  }
> {
  const channel = createChannel<BinaryMessage>();

  const clientId = new Promise<string>((resolve) => {
    source.addEventListener("client-id", (ev) => {
      resolve((ev as MessageEvent).data);
    });
  });

  const handler = (event: Event) => {
    const message = fromBase64((event as MessageEvent).data);
    if (isPingMessage(message)) {
      onPing?.();
      return;
    }
    if (isBinaryMessage(message)) {
      channel.trySend(message);
    }
  };
  source.addEventListener("message", handler);
  source.addEventListener("ping", handler);
  source.addEventListener("error", (e) => {
    if (source.readyState === source.CLOSED) {
      channel.error(e);
    }
  });

  const closeCheck = setInterval(() => {
    if (source.readyState === source.CLOSED) {
      clearInterval(closeCheck);
      channel.close();
    }
  }, 3000);

  const decoded = decodeMessages<Context>(context)(channel);

  async function* decodeSource(): AsyncIterable<Message<Context>[]> {
    try {
      yield* decoded;
    } finally {
      clearInterval(closeCheck);
      source.close();
    }
  }

  return {
    eventSource: source,
    clientId,
    source: decodeSource(),
  };
}
