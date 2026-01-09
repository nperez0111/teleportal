import type { ClientContext, Message, Source, Sink } from "teleportal";
import { decodeMessageArray, encodeMessageArray } from "teleportal";
import { fromMessageArrayStream, getBatchingTransform } from "../utils";

export type DurableStreamsTransportOptions = {
  url: string;
  fetch?: typeof fetch;
  /**
   * Long-poll timeout is server-defined; this just drives client behavior.
   *
   * @default "long-poll"
   */
  live?: "long-poll";
};

/**
 * Create a Durable Streams sink that appends Teleportal messages to a stream URL.
 *
 * The server MUST accept:
 * - `POST {url}` with `Content-Type: application/octet-stream`
 * - body containing Teleportal `MessageArray` bytes.
 */
export function getDurableStreamsSink<Context extends ClientContext>({
  url,
  fetch: fetchImpl,
}: DurableStreamsTransportOptions): Sink<Context> {
  const f = fetchImpl ?? fetch.bind(globalThis);

  const batching = getBatchingTransform({
    maxBatchSize: 25,
    maxBatchDelay: 5,
  });

  batching.readable.pipeTo(
    new WritableStream<Message[]>({
      async write(messages) {
        const body = encodeMessageArray(messages as unknown as Message[]) as unknown as BodyInit;
        const resp = await f(url, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          cache: "no-store",
          body,
        });
        if (!resp.ok && resp.status !== 204) {
          throw new Error(
            `Durable stream append failed: ${resp.status} ${resp.statusText}`,
          );
        }
      },
    }),
  );

  return { writable: batching.writable as unknown as WritableStream<Message<Context>> };
}

/**
 * Create a Durable Streams source that long-polls a stream URL and emits Teleportal messages.
 *
 * The server MUST accept:
 * - `GET {url}?offset=<offset>&live=long-poll[&cursor=<cursor>]`
 * and return:
 * - `Stream-Next-Offset` + optional `Stream-Cursor` headers
 * - body containing Teleportal `MessageArray` bytes (concatenated is allowed)
 */
export function getDurableStreamsSource<Context extends ClientContext>({
  url,
  fetch: fetchImpl,
}: DurableStreamsTransportOptions): Source<Context> {
  const f = fetchImpl ?? fetch.bind(globalThis);

  let offset = "-1";
  let cursor: string | null = null;

  const readable = new ReadableStream<Message<Context>>({
    async start(controller) {
      try {
        while (true) {
          const u = new URL(url);
          u.searchParams.set("live", "long-poll");
          u.searchParams.set("offset", offset);
          if (cursor) u.searchParams.set("cursor", cursor);

          const resp = await f(u.toString(), { method: "GET", cache: "no-store" });
          if (resp.status === 204) {
            offset = resp.headers.get("Stream-Next-Offset") ?? offset;
            cursor = resp.headers.get("Stream-Cursor") ?? cursor;
            continue;
          }
          if (!resp.ok) {
            throw new Error(
              `Durable stream read failed: ${resp.status} ${resp.statusText}`,
            );
          }

          offset = resp.headers.get("Stream-Next-Offset") ?? offset;
          cursor = resp.headers.get("Stream-Cursor") ?? cursor;

          const bytes = new Uint8Array(await resp.arrayBuffer());
          if (bytes.byteLength === 0) continue;

          // Turn concatenated MessageArray bytes into individual messages.
          const messages = decodeMessageArray(bytes as any) as Message<Context>[];
          for (const m of messages) controller.enqueue(m);
        }
      } catch (error_) {
        controller.error(error_);
      }
    },
  });

  return { readable };
}

/**
 * Convenience adapter: interpret an HTTP response body as Teleportal MessageArray bytes.
 * (Matches `teleportal/http` behavior but is useful when using catch-up reads.)
 */
export function decodeDurableStreamsResponse<Context extends ClientContext>(
  response: Response,
  context: Context,
): ReadableStream<Message<Context>> {
  return response.body!.pipeThrough(
    fromMessageArrayStream(context) as TransformStream<Uint8Array, Message<Context>>,
  );
}

