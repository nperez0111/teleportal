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
  #eventListeners: Map<WebSocket, {
    message: (event: MessageEvent) => void;
    error: (event: Event) => void;
    close: (event: CloseEvent) => void;
    open: (event: Event) => void;
  }> = new Map();

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
            const error = new Error(
              "Failed to process message",
              {
                cause: err,
              },
            );
            this.handleConnectionError(error);
          }
        },

        error: (event: Event) => {
          // Only handle errors if this is still the current WebSocket
          if (websocket !== this.#currentWebSocket) {
            return;
          }

          const error = new Error("WebSocket error", { cause: event });
          this.handleConnectionError(error);
        },

        close: (event: CloseEvent) => {
          // Only handle close if this is still the current WebSocket
          if (websocket !== this.#currentWebSocket) {
            return;
          }

          this.#cleanupWebSocketListeners(websocket);
          this.closeConnection();
        },

        open: (event: Event) => {
          // Only handle open if this is still the current WebSocket and we're still connecting
          if (websocket !== this.#currentWebSocket || this.state.type !== "connecting") {
            return;
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
    if (this.#currentWebSocket) {
      const ws = this.#currentWebSocket;
      this.#currentWebSocket = null;

      // Clean up event listeners
      this.#cleanupWebSocketListeners(ws);

      // Close WebSocket if it's still open
      if (ws.readyState === this.#WebSocketImpl.OPEN || ws.readyState === this.#WebSocketImpl.CONNECTING) {
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

    await this.#cleanupCurrentWebSocket();
    
    // Clean up any remaining event listeners
    for (const [ws] of this.#eventListeners) {
      this.#cleanupWebSocketListeners(ws);
    }
    this.#eventListeners.clear();

    await super.destroy();
  }
}
