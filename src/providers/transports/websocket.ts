import {
  decodeMessage,
  encodePingMessage,
  isBinaryMessage,
  isPongMessage,
  type Message,
} from "teleportal";
import type { ConnectionTransport, TransportConnectContext } from "./types";

export interface WebSocketTransportOptions {
  /**
   * Time in milliseconds to wait for the WebSocket to open before rejecting.
   *
   * @default 5000
   */
  timeout?: number;

  /**
   * The protocols to use for the WebSocket connection.
   */
  protocols?: string[];

  /**
   * The WebSocket implementation to use.
   */
  WebSocket?: typeof WebSocket;
}

/**
 * Creates a lightweight WebSocket transport that implements {@link ConnectionTransport}.
 *
 * Internal state (current WebSocket, event listeners) is held in closure variables
 * rather than class fields.
 */
export function websocketTransport(options?: WebSocketTransportOptions): ConnectionTransport {
  const timeoutMs = options?.timeout ?? 5000;
  const protocols = options?.protocols ?? [];
  const WebSocketImpl = options?.WebSocket ?? WebSocket;

  let ws: WebSocket | null = null;
  let listeners: {
    message: (event: MessageEvent) => void;
    error: (event: Event) => void;
    close: (event: CloseEvent) => void;
    open: (event: Event) => void;
  } | null = null;

  function cleanup() {
    if (ws && listeners) {
      ws.removeEventListener("message", listeners.message);
      ws.removeEventListener("error", listeners.error);
      ws.removeEventListener("close", listeners.close);
      ws.removeEventListener("open", listeners.open);
    }
    listeners = null;

    if (ws) {
      const socket = ws;
      ws = null;
      if (
        socket.readyState === WebSocketImpl.OPEN ||
        socket.readyState === WebSocketImpl.CONNECTING
      ) {
        try {
          socket.close(1000);
        } catch {
          // ignore
        }
      }
    }
  }

  const transport: ConnectionTransport = {
    name: "websocket",
    timeout: timeoutMs,

    connect(ctx: TransportConnectContext): Promise<void> {
      // Clean up any previous WebSocket before creating a new one
      cleanup();

      return new Promise<void>((resolve, reject) => {
        if (!ctx.url) {
          reject(new Error("WebSocket transport requires a URL"));
          return;
        }

        // Convert http(s) to ws(s)
        const url = new URL(ctx.url);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

        // Append token as query parameter if provided
        if (ctx.token) {
          url.searchParams.set("token", ctx.token);
        }

        let settled = false;
        let connectionTimeout: ReturnType<typeof setTimeout> | null = null;

        const socket = new WebSocketImpl(url.toString(), protocols);
        socket.binaryType = "arraybuffer";
        ws = socket;

        // Set up connection timeout
        connectionTimeout = ctx.timer.setTimeout(() => {
          if (!settled) {
            settled = true;
            cleanup();
            reject(
              new Error(
                `WebSocket connection timeout - connection did not open within ${timeoutMs}ms`,
              ),
            );
          }
        }, timeoutMs);

        const eventListeners = {
          message: (event: MessageEvent) => {
            if (socket !== ws) return;

            try {
              const message = new Uint8Array(event.data as ArrayBuffer);

              if (!isBinaryMessage(message)) {
                cleanup();
                ctx.onClose(new Error("Invalid message"));
                return;
              }

              if (isPongMessage(message)) {
                ctx.onPing();
                return;
              }

              const decoded = decodeMessage(message);
              ctx.onMessage(decoded);
            } catch (err) {
              cleanup();
              ctx.onClose(new Error("Failed to process message", { cause: err }));
            }
          },

          error: (event: Event) => {
            if (socket !== ws) return;

            if (!settled) {
              settled = true;
              if (connectionTimeout) {
                ctx.timer.clearTimeout(connectionTimeout);
                connectionTimeout = null;
              }
              cleanup();
              reject(new Error("WebSocket error", { cause: event }));
              return;
            }

            // After connected, only treat as fatal if the socket is closed/closing
            if (
              socket.readyState === WebSocketImpl.CLOSED ||
              socket.readyState === WebSocketImpl.CLOSING
            ) {
              cleanup();
              ctx.onClose(new Error("WebSocket error", { cause: event }));
            }
          },

          close: (event: CloseEvent) => {
            if (socket !== ws) return;

            if (connectionTimeout) {
              ctx.timer.clearTimeout(connectionTimeout);
              connectionTimeout = null;
            }

            if (!settled) {
              settled = true;
              cleanup();
              reject(new Error("WebSocket connection closed before opening", { cause: event }));
              return;
            }

            cleanup();
            ctx.onClose();
          },

          open: (_event: Event) => {
            if (socket !== ws) return;

            if (connectionTimeout) {
              ctx.timer.clearTimeout(connectionTimeout);
              connectionTimeout = null;
            }

            if (!settled) {
              settled = true;
              resolve();
            }
          },
        };

        listeners = eventListeners;
        socket.addEventListener("message", eventListeners.message);
        socket.addEventListener("error", eventListeners.error);
        socket.addEventListener("close", eventListeners.close);
        socket.addEventListener("open", eventListeners.open);
      });
    },

    async send(message: Message): Promise<void> {
      if (!ws || ws.readyState !== WebSocketImpl.OPEN) {
        throw new Error("WebSocket is not connected");
      }
      ws.send(message.encoded as Uint8Array<ArrayBuffer>);
    },

    async close(): Promise<void> {
      cleanup();
    },

    sendHeartbeat(): void {
      if (ws && ws.readyState === WebSocketImpl.OPEN) {
        try {
          ws.send(encodePingMessage() as Uint8Array<ArrayBuffer>);
        } catch {
          // no-op
        }
      }
    },
  };

  return transport;
}
