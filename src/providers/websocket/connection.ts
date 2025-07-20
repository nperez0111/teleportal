import {
  decodeMessage,
  encodePingMessage,
  isBinaryMessage,
  isPongMessage,
  type Message,
  type RawReceivedMessage,
} from "teleportal";
import { createFanOutWriter } from "teleportal/transports";
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

    try {
      const websocket = new this.#WebSocketImpl(this.#url, this.#protocols);
      websocket.binaryType = "arraybuffer";
      this.setState({ type: "connecting", context: { ws: websocket } });

      websocket.addEventListener("message", async (event) => {
        this.updateLastMessageReceived();
        const message = new Uint8Array(event.data as ArrayBuffer);

        if (!isBinaryMessage(message)) {
          const error = new Error("Invalid message", { cause: event });
          this.handleConnectionError(error);
          return;
        }

        if (isPongMessage(message)) {
          return;
        }

        try {
          const decodedMessage = decodeMessage(message);
          await this.writer.write(decodedMessage);
          this.call("message", decodedMessage);
        } catch (err) {
          const error = new Error(
            "Failed to write message to internal stream",
            {
              cause: err,
            },
          );
          this.handleConnectionError(error);
        }
      });

      websocket.addEventListener("error", (event) => {
        const error = new Error("WebSocket error", { cause: event });
        this.handleConnectionError(error);
      });

      websocket.addEventListener("close", () => {
        this.closeConnection();
      });

      websocket.addEventListener("open", () => {
        this.updateLastMessageReceived();
        this.setState({ type: "connected", context: { ws: websocket } });
      });
    } catch (error) {
      this.handleConnectionError(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  protected async sendMessage(message: Message): Promise<void> {
    if (
      this.state.type === "connected" &&
      this.state.context.ws.readyState === this.#WebSocketImpl.OPEN
    ) {
      this.state.context.ws.send(message.encoded);
    }
  }

  protected sendHeartbeat(): void {
    if (
      this.state.type === "connected" &&
      this.state.context.ws.readyState === this.#WebSocketImpl.OPEN
    ) {
      try {
        this.state.context.ws.send(encodePingMessage());
      } catch (e) {
        // no-op
      }
    }
  }

  protected async closeConnection(): Promise<void> {
    if (this.state.type === "connected" || this.state.type === "connecting") {
      this.state.context.ws.close();
      this.setState({ type: "disconnected", context: { ws: null } });
    }
  }
}
