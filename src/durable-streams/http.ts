import { DurableStreamStore, computeCursor } from "./store";

export type DurableStreamsHandlerOptions = {
  /**
   * Durable stream storage backend.
   */
  store: DurableStreamStore;
  /**
   * URL path prefix that identifies stream URLs.
   *
   * @default "/v1/stream"
   */
  basePath?: string;
  /**
   * Default content type to use for PUT when none is provided.
   *
   * @default "application/octet-stream"
   */
  defaultContentType?: string;
  /**
   * Long-poll timeout in milliseconds.
   *
   * @default 25000
   */
  longPollTimeoutMs?: number;
};

export type DurableStreamsRequestInfo = {
  /**
   * The stream key extracted from the request URL.
   */
  key: string;
};

export type DurableStreamsHandler = (req: Request) => Promise<Response>;

export function getDurableStreamsHandler({
  store,
  basePath = "/v1/stream",
  defaultContentType = "application/octet-stream",
  longPollTimeoutMs = 25_000,
}: DurableStreamsHandlerOptions): DurableStreamsHandler {
  const normalizedBase = basePath.endsWith("/")
    ? basePath.slice(0, -1)
    : basePath;

  function getKey(url: URL): string | null {
    if (!url.pathname.startsWith(normalizedBase)) return null;
    const rest = url.pathname.slice(normalizedBase.length);
    if (!rest || rest === "/") return null;
    return decodeURIComponent(rest.startsWith("/") ? rest.slice(1) : rest);
  }

  function powered(headers: HeadersInit = {}): Headers {
    const h = new Headers(headers);
    h.set("x-powered-by", "teleportal");
    return h;
  }

  function isSseCompatible(contentType: string): boolean {
    return (
      contentType === "application/json" ||
      contentType.startsWith("text/") ||
      contentType.startsWith("text;")
    );
  }

  function makeEtag(key: string, offset: string, nextOffset: string) {
    // Simple strong ETag derived from key + offsets.
    // The spec’s exact structure isn’t required; only cache validation behavior.
    return `"${key}:${offset}:${nextOffset}"`;
  }

  return async (req) => {
    const url = new URL(req.url);
    const key = getKey(url);
    if (!key) {
      return new Response("Not Found", { status: 404 });
    }

    const method = req.method.toUpperCase();
    const contentTypeHeader = req.headers.get("Content-Type");

    try {
      if (method === "PUT") {
        const contentType = contentTypeHeader ?? defaultContentType;
        const existed = store.hasStream(key);
        store.ensureStream(key, contentType);

        // Optional initial content
        const created = !existed;
        if (req.body) {
          const bytes = new Uint8Array(await req.arrayBuffer());
          if (bytes.byteLength > 0) {
            store.appendBytes(key, bytes);
          }
        }

        const newRecord = store.getRecordByKey(key)!;
        return new Response(null, {
          status: created ? 201 : 200,
          headers: powered({
            ...(created ? { Location: url.toString() } : {}),
            "Content-Type": newRecord.contentType,
            "Stream-Next-Offset": newRecord.nextOffset,
            "Cache-Control": "no-store",
          }),
        });
      }

      if (method === "DELETE") {
        const deleted = store.deleteStream(key);
        return new Response(null, {
          status: deleted ? 204 : 404,
          headers: powered({ "Cache-Control": "no-store" }),
        });
      }

      if (method === "HEAD") {
        const record = store.getRecordByKey(key);
        if (!record) {
          return new Response(null, { status: 404, headers: powered() });
        }
        return new Response(null, {
          status: 200,
          headers: powered({
            "Content-Type": record.contentType,
            "Stream-Next-Offset": record.nextOffset,
            "Cache-Control": "no-store",
          }),
        });
      }

      if (method === "POST") {
        const record = store.getRecordByKey(key);
        if (!record) {
          return new Response("Not Found", { status: 404, headers: powered() });
        }
        if (!contentTypeHeader) {
          return new Response("Missing Content-Type", {
            status: 400,
            headers: powered(),
          });
        }
        if (contentTypeHeader !== record.contentType) {
          return new Response("Content-Type mismatch", {
            status: 409,
            headers: powered({
              "Content-Type": "text/plain",
              "Cache-Control": "no-store",
            }),
          });
        }

        const bytes = new Uint8Array(await req.arrayBuffer());
        if (bytes.byteLength === 0) {
          return new Response("Empty append", { status: 400, headers: powered() });
        }

        const next = store.appendBytes(key, bytes);
        return new Response(null, {
          status: 204,
          headers: powered({
            "Stream-Next-Offset": next.nextOffset,
            "Cache-Control": "no-store",
          }),
        });
      }

      if (method === "GET") {
        const record = store.getRecordByKey(key);
        if (!record) {
          return new Response("Not Found", { status: 404, headers: powered() });
        }

        const offsetParam = url.searchParams.get("offset") ?? "-1";
        const live = url.searchParams.get("live");
        const cursorParam = url.searchParams.get("cursor");
        const cursor = computeCursor(cursorParam);

        if (live === "sse") {
          if (!isSseCompatible(record.contentType)) {
            return new Response("SSE not supported for this content type", {
              status: 400,
              headers: powered({ "Cache-Control": "no-store" }),
            });
          }

          // Minimal SSE implementation: emit "data" events containing UTF-8 text,
          // plus "control" events with next offset + cursor.
          const encoder = new TextEncoder();
          let currentOffset = offsetParam;

          const readable = new ReadableStream<Uint8Array>({
            async start(controller) {
              // Best-effort initial control event
              const init = store.readBytes(key, currentOffset);
              currentOffset = init.nextOffset;
              controller.enqueue(
                encoder.encode(
                  `event: control\ndata: ${JSON.stringify({
                    streamNextOffset: currentOffset,
                    streamCursor: cursor,
                    upToDate: init.upToDate,
                  })}\n\n`,
                ),
              );

              // Close after ~60s to encourage collapsing.
              const closeTimer = setTimeout(() => {
                try {
                  controller.close();
                } catch {
                  // ignore
                }
              }, 60_000);

              try {
                while (true) {
                  const res = store.readBytes(key, currentOffset);
                  if (res.bytes.byteLength > 0) {
                    const text = new TextDecoder().decode(res.bytes);
                    // Split into SSE data lines.
                    const lines = text.split("\n");
                    controller.enqueue(encoder.encode(`event: data\n`));
                    for (const line of lines) {
                      controller.enqueue(encoder.encode(`data: ${line}\n`));
                    }
                    controller.enqueue(encoder.encode(`\n`));
                    currentOffset = res.nextOffset;
                    controller.enqueue(
                      encoder.encode(
                        `event: control\ndata: ${JSON.stringify({
                          streamNextOffset: currentOffset,
                          streamCursor: cursor,
                        })}\n\n`,
                      ),
                    );
                  } else {
                    // Wait for new data, then loop.
                    await store.waitForAppend(key, 10_000);
                  }
                }
              } catch {
                // ignore
              } finally {
                clearTimeout(closeTimer);
              }
            },
          });

          return new Response(readable, {
            status: 200,
            headers: powered({
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-store",
            }),
          });
        }

        if (live === "long-poll") {
          if (!offsetParam) {
            return new Response("Missing offset", {
              status: 400,
              headers: powered(),
            });
          }

          const first = store.readBytes(key, offsetParam);
          if (first.bytes.byteLength > 0) {
            return new Response(first.bytes as unknown as BodyInit, {
              status: 200,
              headers: powered({
                "Content-Type": record.contentType,
                "Stream-Next-Offset": first.nextOffset,
                "Stream-Up-To-Date": "true",
                "Stream-Cursor": cursor,
                "Cache-Control": "private, max-age=60, stale-while-revalidate=300",
                ETag: offsetParam === "now"
                  ? ""
                  : makeEtag(key, offsetParam, first.nextOffset),
              }),
            });
          }

          await store.waitForAppend(key, longPollTimeoutMs);
          const second = store.readBytes(key, offsetParam);
          if (second.bytes.byteLength > 0) {
            return new Response(second.bytes as unknown as BodyInit, {
              status: 200,
              headers: powered({
                "Content-Type": record.contentType,
                "Stream-Next-Offset": second.nextOffset,
                "Stream-Up-To-Date": "true",
                "Stream-Cursor": cursor,
                "Cache-Control": "private, max-age=60, stale-while-revalidate=300",
                ETag: offsetParam === "now"
                  ? ""
                  : makeEtag(key, offsetParam, second.nextOffset),
              }),
            });
          }

          // Timeout with no new data.
          return new Response(null, {
            status: 204,
            headers: powered({
              "Stream-Next-Offset": second.nextOffset,
              "Stream-Up-To-Date": "true",
              "Stream-Cursor": cursor,
              "Cache-Control": "no-store",
            }),
          });
        }

        // Catch-up
        const res = store.readBytes(key, offsetParam);
        const etag =
          offsetParam === "now" ? null : makeEtag(key, offsetParam, res.nextOffset);
        const inm = req.headers.get("If-None-Match");
        if (etag && inm && inm === etag) {
          return new Response(null, {
            status: 304,
            headers: powered({
              ETag: etag,
              "Stream-Next-Offset": res.nextOffset,
              "Stream-Up-To-Date": "true",
              "Stream-Cursor": cursor,
              "Cache-Control": "private, max-age=60, stale-while-revalidate=300",
            }),
          });
        }

        return new Response(res.bytes as unknown as BodyInit, {
          status: 200,
          headers: powered({
            "Content-Type": record.contentType,
            "Stream-Next-Offset": res.nextOffset,
            "Stream-Up-To-Date": "true",
            "Stream-Cursor": cursor,
            "Cache-Control":
              offsetParam === "now"
                ? "no-store"
                : "private, max-age=60, stale-while-revalidate=300",
            ...(etag ? { ETag: etag } : {}),
          }),
        });
      }

      return new Response("Method Not Allowed", {
        status: 405,
        headers: powered({ Allow: "PUT,POST,GET,HEAD,DELETE" }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(message, { status: 500, headers: powered() });
    }
  };
}

