import {
  decodeMessage,
  encodePingMessage,
  isBinaryMessage,
  isPongMessage,
  type Message,
} from "teleportal";
import { Connection, ConnectionOptions } from "../connection";

export type WebSocketConnectContext = {
  connected: {
    ws: WebSocket;
  };
  disconnected: {
    ws: null;
  };
  connecting: {
    ws: WebSocket;
  };
  errored: {
    reconnectAttempt: number;
  };
};

export type WebSocketConnectionOptions = {
  /**
   * The URL of the websocket endpoint
   */
  url: string;
  /**
   * The protocols to use for the websocket connection
   */
  protocols?: string[];
  /**
   * The WebSocket implementation to use
   */
  WebSocket?: typeof WebSocket;
  /**
   * Time in milliseconds to wait for the WebSocket to open before failing and reconnecting.
   *
   * @default 10000
   */
  connectionTimeout?: number;
} & ConnectionOptions;

const DEFAULT_CONNECTION_TIMEOUT = 10_000;

export class WebSocketConnection extends Connection<WebSocketConnectContext> {
  #url: string;
  #protocols: string[];
  #WebSocketImpl: typeof WebSocket;
  #connectionTimeoutMs: number;
  #currentWebSocket: WebSocket | null = null;
  #eventListeners: Map<
    WebSocket,
    {
      message: (event: MessageEvent) => void;
      error: (event: Event) => void;
      close: (event: CloseEvent) => void;
      open: (event: Event) => void;
    }
  > = new Map();
  #connectionTimeout: ReturnType<typeof setTimeout> | null = null;

  /**
   * A writable stream to send messages over the websocket connection
   */
  public writable: WritableStream<Message> = new WritableStream({
    write: (message) => {
      this.send(message);
    },
  });

  constructor(options: WebSocketConnectionOptions) {
    super(options);

    this.#url = options.url;
    this.#protocols = options.protocols ?? [];
    this.#WebSocketImpl = options.WebSocket ?? WebSocket;
    this.#connectionTimeoutMs =
      options.connectionTimeout ?? DEFAULT_CONNECTION_TIMEOUT;

    // Initialize the state with the correct WebSocket context
    this._state = {
      type: "disconnected",
      context: { ws: null },
    };
  }

  protected async initConnection(): Promise<void> {
    if (this.destroyed) {
      throw new Error(
        "WebSocketConnection is destroyed, create a new instance",
      );
    }

    if (!this.shouldAttemptConnection()) {
      return;
    }

    // Prevent concurrent connection attempts - only use state
    if (this.state.type === "connecting" || this.state.type === "connected") {
      return;
    }

    try {
      // Clean up any existing WebSocket
      await this.#cleanupCurrentWebSocket();

      const websocket = new this.#WebSocketImpl(this.#url, this.#protocols);
      websocket.binaryType = "arraybuffer";
      this.#currentWebSocket = websocket;

      // Set state to connecting first
      this.setState({ type: "connecting", context: { ws: websocket } });

      // Set up connection timeout to handle cases where connection gets stuck.
      // Proactively close the socket so we don't leave it hanging.
      this.#connectionTimeout = this.timerManager.setTimeout(() => {
        if (
          this.#currentWebSocket === websocket &&
          this.state.type === "connecting"
        ) {
          this.#currentWebSocket = null;
          this.#cleanupWebSocketListeners(websocket);
          try {
            if (
              websocket.readyState === this.#WebSocketImpl.OPEN ||
              websocket.readyState === this.#WebSocketImpl.CONNECTING
            ) {
              websocket.close(1000, "Connection timeout");
            }
          } catch {
            // ignore
          }
          const error = new Error(
            `WebSocket connection timeout - connection did not open within ${this.#connectionTimeoutMs}ms`,
          );
          this.handleConnectionError(error);
        }
      }, this.#connectionTimeoutMs);

      // Set up event listeners with proper cleanup tracking
      const listeners = {
        message: async (event: MessageEvent) => {
          // Only handle messages if this is still the current WebSocket
          if (websocket !== this.#currentWebSocket) {
            return;
          }

          this.updateLastMessageReceived();

          try {
            const message = new Uint8Array(event.data as ArrayBuffer);

            if (!isBinaryMessage(message)) {
              const error = new Error("Invalid message", { cause: event });
              this.handleConnectionError(error);
              return;
            }

            if (isPongMessage(message)) {
              this.call("ping");
              return;
            }

            const decodedMessage = decodeMessage(message);
            await this.writer.write(decodedMessage);
            this.call("received-message", decodedMessage);
          } catch (err) {
            this.handleConnectionError(
              new Error("Failed to process message", {
                cause: err,
              }),
            );
          }
        },

        error: (event: Event) => {
          // Only handle errors if this is still the current WebSocket
          if (websocket !== this.#currentWebSocket) {
            return;
          }

          // Error events can be fired during connection setup even if the connection
          // will succeed. Only treat as fatal if the WebSocket is actually closed or
          // closing. If still connecting, the close event will handle it if the
          // connection actually fails.
          const readyState = websocket.readyState;
          if (
            readyState === this.#WebSocketImpl.CLOSED ||
            readyState === this.#WebSocketImpl.CLOSING
          ) {
            this.handleConnectionError(
              new Error("WebSocket error", { cause: event }),
            );
          }
          // If still CONNECTING or already OPEN, ignore the error - let close event handle failures
        },

        close: (event: CloseEvent) => {
          // Only handle close if this is still the current WebSocket
          if (websocket !== this.#currentWebSocket) {
            return;
          }

          // Clear connection timeout
          if (this.#connectionTimeout) {
            this.timerManager.clearTimeout(this.#connectionTimeout);
            this.#connectionTimeout = null;
          }

          this.#cleanupWebSocketListeners(websocket);

          // Capture the current state at the start to avoid race conditions where the open
          // event fires after the close event but before we check the state. If the state
          // is "connected", we know the connection was successfully opened, so treat as
          // normal close. If the state is "connecting" and the WebSocket never opened
          // (readyState is not OPEN/CLOSING), treat as error.
          const currentState = this.state.type;
          const readyState = websocket.readyState;
          const wasOpenOrClosing =
            readyState === this.#WebSocketImpl.OPEN ||
            readyState === this.#WebSocketImpl.CLOSING;

          // If the connection was successfully opened (state is connected OR readyState indicates
          // it was open), treat as normal close
          if (currentState === "connected" || wasOpenOrClosing) {
            this.closeConnection();
            return;
          }

          // If we were still connecting and the WebSocket never opened, treat as error.
          // Clear the socket reference and close the underlying ws so we don't hold a dead reference.
          if (currentState === "connecting") {
            this.#currentWebSocket = null;
            try {
              if (
                readyState === this.#WebSocketImpl.OPEN ||
                readyState === this.#WebSocketImpl.CONNECTING
              ) {
                websocket.close(1000, "Connection failed");
              }
            } catch {
              // ignore
            }
            const error = new Error(
              "WebSocket connection closed during handshake",
              {
                cause: event,
              },
            );
            this.handleConnectionError(error);
            return;
          }

          // Otherwise, treat as normal close (state is disconnected or errored)
          this.closeConnection();
        },

        open: (event: Event) => {
          // Only handle open if this is still the current WebSocket and we're still connecting
          if (
            websocket !== this.#currentWebSocket ||
            this.state.type !== "connecting"
          ) {
            return;
          }

          // Clear connection timeout since connection succeeded
          if (this.#connectionTimeout) {
            this.timerManager.clearTimeout(this.#connectionTimeout);
            this.#connectionTimeout = null;
          }

          this.updateLastMessageReceived();
          this.setState({ type: "connected", context: { ws: websocket } });
        },
      };

      // Add event listeners and track them
      websocket.addEventListener("message", listeners.message);
      websocket.addEventListener("error", listeners.error);
      websocket.addEventListener("close", listeners.close);
      websocket.addEventListener("open", listeners.open);

      this.#eventListeners.set(websocket, listeners);
    } catch (error) {
      this.handleConnectionError(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  #cleanupWebSocketListeners(websocket: WebSocket): void {
    const listeners = this.#eventListeners.get(websocket);
    if (listeners) {
      websocket.removeEventListener("message", listeners.message);
      websocket.removeEventListener("error", listeners.error);
      websocket.removeEventListener("close", listeners.close);
      websocket.removeEventListener("open", listeners.open);
      this.#eventListeners.delete(websocket);
    }
  }

  async #cleanupCurrentWebSocket(): Promise<void> {
    // Clear connection timeout
    if (this.#connectionTimeout) {
      this.timerManager.clearTimeout(this.#connectionTimeout);
      this.#connectionTimeout = null;
    }

    if (this.#currentWebSocket) {
      const ws = this.#currentWebSocket;
      this.#currentWebSocket = null;

      // Clean up event listeners
      this.#cleanupWebSocketListeners(ws);

      // Close WebSocket if it's still open
      if (
        ws.readyState === this.#WebSocketImpl.OPEN ||
        ws.readyState === this.#WebSocketImpl.CONNECTING
      ) {
        try {
          ws.close(1000, "Connection cleanup");
        } catch (error) {
          // Ignore errors during cleanup
        }
      }
    }
  }

  protected async sendMessage(message: Message): Promise<void> {
    const ws = this.#currentWebSocket;
    if (
      this.state.type === "connected" &&
      ws &&
      ws.readyState === this.#WebSocketImpl.OPEN
    ) {
      try {
        ws.send(message.encoded);
        this.call("sent-message", message);
      } catch (error) {
        // Re-throw to let base class handle buffering
        throw error;
      }
    } else {
      throw new Error("Not connected - message should be buffered");
    }
  }

  protected sendHeartbeat(): void {
    const ws = this.#currentWebSocket;
    if (
      this.state.type === "connected" &&
      ws &&
      ws.readyState === this.#WebSocketImpl.OPEN
    ) {
      try {
        ws.send(encodePingMessage());
      } catch (e) {
        // no-op
      }
    }
  }

  protected async closeConnection(): Promise<void> {
    await this.#cleanupCurrentWebSocket();
    this.setState({ type: "disconnected", context: { ws: null } });
  }

  public async destroy(): Promise<void> {
    if (this.destroyed) {
      return;
    }

    // Clear connection timeout
    if (this.#connectionTimeout) {
      this.timerManager.clearTimeout(this.#connectionTimeout);
      this.#connectionTimeout = null;
    }

    await this.#cleanupCurrentWebSocket();

    // Clean up any remaining event listeners
    for (const [ws] of this.#eventListeners) {
      this.#cleanupWebSocketListeners(ws);
    }
    this.#eventListeners.clear();

    await super.destroy();
  }
}
