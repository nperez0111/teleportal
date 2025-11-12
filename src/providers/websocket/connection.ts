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
} & ConnectionOptions;

export class WebSocketConnection extends Connection<WebSocketConnectContext> {
  #url: string;
  #protocols: string[];
  #WebSocketImpl: typeof WebSocket;
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

      // Set up connection timeout (10 seconds) to handle cases where connection gets stuck
      this.#connectionTimeout = Connection.setTimeout(() => {
        if (
          this.#currentWebSocket === websocket &&
          this.state.type === "connecting"
        ) {
          const error = new Error(
            "WebSocket connection timeout - connection did not open within 10 seconds",
          );
          this.handleConnectionError(error);
        }
      }, 10000);

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
            this.call("message", decodedMessage);
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
            clearTimeout(this.#connectionTimeout);
            this.#connectionTimeout = null;
          }

          this.#cleanupWebSocketListeners(websocket);

          // If we were still connecting when the connection closed, check if the WebSocket
          // actually opened. If the WebSocket is OPEN, treat as normal close (open event
          // might not have fired yet due to timing). If not OPEN, treat as error since
          // the connection never successfully opened.
          if (
            this.state.type === "connecting" &&
            websocket.readyState !== this.#WebSocketImpl.OPEN
          ) {
            const error = new Error(
              "WebSocket connection closed during handshake",
              {
                cause: event,
              },
            );
            this.handleConnectionError(error);
          } else {
            this.closeConnection();
          }
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
            clearTimeout(this.#connectionTimeout);
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
      Connection.clearTimeout(this.#connectionTimeout);
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
      Connection.clearTimeout(this.#connectionTimeout);
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
