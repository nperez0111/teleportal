import type { Message, ClientContext, Sink } from "teleportal";
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
  let httpSink: Sink<ClientContext> | null = null;
  let streamAbortController: AbortController | null = null;

  function cleanup() {
    if (streamAbortController) {
      streamAbortController.abort("Connection cleanup");
      streamAbortController = null;
    }

    if (httpSink) {
      try {
        httpSink.close();
      } catch {
        // Ignore errors when closing
      }
      httpSink = null;
    }

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
      cleanup();

      return new Promise<void>((resolve, reject) => {
        if (!ctx.url) {
          reject(new Error("HTTP transport requires a URL"));
          return;
        }

        let settled = false;
        let connectionTimeout: ReturnType<typeof setTimeout> | null = null;

        const sseUrl = new URL(ctx.url);
        if (sseUrl.protocol === "ws:") sseUrl.protocol = "http:";
        if (sseUrl.protocol === "wss:") sseUrl.protocol = "https:";
        sseUrl.pathname += sseUrl.pathname.endsWith("/") ? "sse" : "/sse";

        if (ctx.token) {
          sseUrl.searchParams.set("token", ctx.token);
        }

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

        source = getSSESource({
          context: {} as ClientContext,
          source: new EventSourceImpl(sseUrl.toString()),
          onPing: () => {
            ctx.onPing();
          },
        });

        source.clientId
          .then((clientId) => {
            if (settled) return;

            if (connectionTimeout) {
              ctx.timer.clearTimeout(connectionTimeout);
              connectionTimeout = null;
            }

            const context = { clientId } satisfies ClientContext;

            httpSink = getHTTPSink({
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

            streamAbortController = new AbortController();
            const signal = streamAbortController.signal;

            // Consume SSE source and forward messages via ctx.onMessage
            (async () => {
              try {
                for await (const batch of source!.source) {
                  if (signal.aborted) break;
                  for (const chunk of batch) {
                    ctx.onMessage(chunk);
                  }
                }
                ctx.onClose();
              } catch (error) {
                if (signal.aborted) {
                  ctx.onClose();
                } else {
                  ctx.onClose(error instanceof Error ? error : new Error(String(error)));
                }
              }
            })();

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
      if (!httpSink) {
        throw new Error("HTTP transport is not connected");
      }
      await httpSink.write(message);
    },

    async close(): Promise<void> {
      cleanup();
    },
  };

  return transport;
}
