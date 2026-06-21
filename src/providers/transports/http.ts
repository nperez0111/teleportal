import type { Message, RawReceivedMessage, ClientContext } from "teleportal";
import { getHTTPSink, getSSESource, type BatchingOptions } from "teleportal/transports";
import type { ConnectionTransport, TransportConnectContext } from "./types";

export interface HttpTransportOptions {
  /**
   * Time in milliseconds to wait for the SSE connection to establish before rejecting.
   *
   * @default 10000
   */
  timeout?: number;

  /**
   * The fetch implementation to use.
   */
  fetch?: typeof fetch;

  /**
   * The EventSource implementation to use.
   */
  EventSource?: typeof EventSource;

  /**
   * Options for batching outbound HTTP messages.
   * Controls `maxBatchSize` and `maxBatchDelay` on the HTTP sink.
   */
  httpBatchingOptions?: BatchingOptions;
}

/**
 * Creates a lightweight HTTP transport that implements {@link ConnectionTransport}.
 *
 * Uses Server-Sent Events (SSE) for server-to-client communication and
 * HTTP POST for client-to-server communication. Internal state is held
 * in closure variables rather than class fields.
 */
export function httpTransport(options?: HttpTransportOptions): ConnectionTransport {
  const timeoutMs = options?.timeout ?? 10000;
  const fetchImpl = options?.fetch ?? fetch.bind(globalThis);
  const EventSourceImpl = options?.EventSource ?? EventSource;
  const httpBatchingOptions = options?.httpBatchingOptions;

  let source: ReturnType<typeof getSSESource> | null = null;
  let httpWriter: WritableStreamDefaultWriter<RawReceivedMessage> | null = null;
  let streamAbortController: AbortController | null = null;

  function cleanup() {
    // Abort any ongoing stream processing
    if (streamAbortController) {
      streamAbortController.abort("Connection cleanup");
      streamAbortController = null;
    }

    // Close and clean up HTTP writer
    if (httpWriter) {
      const writer = httpWriter;
      httpWriter = null;
      try {
        writer.close().catch(() => {});
      } catch {
        // Ignore errors when closing writer, it might already be closed
      }
      try {
        writer.releaseLock();
      } catch {
        // Ignore errors when releasing lock
      }
    }

    // Close and clean up EventSource
    if (source) {
      try {
        source.eventSource.close();
      } catch {
        // Ignore errors when closing EventSource
      }
      source = null;
    }
  }

  const transport: ConnectionTransport = {
    name: "http",
    timeout: timeoutMs,

    connect(ctx: TransportConnectContext): Promise<void> {
      // Clean up any previous connection before creating a new one
      cleanup();

      return new Promise<void>((resolve, reject) => {
        if (!ctx.url) {
          reject(new Error("HTTP transport requires a URL"));
          return;
        }

        let settled = false;
        let connectionTimeout: ReturnType<typeof setTimeout> | null = null;

        // Build the SSE URL: convert ws(s) to http(s), append /sse
        const sseUrl = new URL(ctx.url);
        if (sseUrl.protocol === "ws:") sseUrl.protocol = "http:";
        if (sseUrl.protocol === "wss:") sseUrl.protocol = "https:";
        sseUrl.pathname += sseUrl.pathname.endsWith("/") ? "sse" : "/sse";

        // Append token as query parameter if provided
        if (ctx.token) {
          sseUrl.searchParams.set("token", ctx.token);
        }

        // Set up connection timeout
        connectionTimeout = ctx.timer.setTimeout(() => {
          if (!settled) {
            settled = true;
            cleanup();
            reject(
              new Error(
                `HTTP SSE connection timeout - clientId not received within ${timeoutMs}ms`,
              ),
            );
          }
        }, timeoutMs);

        // Create the SSE source
        source = getSSESource({
          context: {} as ClientContext,
          source: new EventSourceImpl(sseUrl.toString()),
          onPing: () => {
            ctx.onPing();
          },
        });

        // Wait for the clientId to establish the connection
        source.clientId
          .then((clientId) => {
            if (settled) return;

            if (connectionTimeout) {
              ctx.timer.clearTimeout(connectionTimeout);
              connectionTimeout = null;
            }

            // Create the HTTP sink for sending messages
            const context = { clientId } satisfies ClientContext;

            const sink = getHTTPSink({
              context,
              request: async ({ requestOptions }) => {
                const resp = await fetchImpl(sseUrl.toString(), requestOptions);
                if (!resp.ok) {
                  throw new Error(
                    `HTTP request failed with status ${resp.status}: ${resp.statusText}`,
                  );
                }
              },
              batchingOptions: httpBatchingOptions,
            });

            // Get the writer for sending messages
            httpWriter = sink.writable.getWriter();

            // Set up stream processing with abort controller
            streamAbortController = new AbortController();
            const signal = streamAbortController.signal;

            // Pipe the SSE readable stream to route messages via ctx.onMessage
            source!.readable
              .pipeTo(
                new WritableStream({
                  write(chunk) {
                    if (signal.aborted) {
                      throw new Error("Stream processing aborted");
                    }
                    ctx.onMessage(chunk);
                  },
                }),
                { signal },
              )
              .then(() => {
                // Normal stream completion.
                ctx.onClose();
              })
              .catch((error) => {
                // On abort (deliberate close) report a clean close; otherwise
                // surface the error. Exactly one onClose per teardown.
                if (signal.aborted) {
                  ctx.onClose();
                } else {
                  ctx.onClose(error instanceof Error ? error : new Error(String(error)));
                }
              });

            settled = true;
            resolve();
          })
          .catch((error) => {
            if (!settled) {
              settled = true;
              if (connectionTimeout) {
                ctx.timer.clearTimeout(connectionTimeout);
                connectionTimeout = null;
              }
              cleanup();
              reject(new Error("Failed to establish SSE connection", { cause: error }));
            }
          });
      });
    },

    async send(message: Message): Promise<void> {
      if (!httpWriter) {
        throw new Error("HTTP transport is not connected");
      }
      await httpWriter.write(message);
    },

    async close(): Promise<void> {
      cleanup();
    },
  };

  return transport;
}
