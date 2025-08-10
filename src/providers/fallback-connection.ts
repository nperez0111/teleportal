import { Message, RawReceivedMessage } from "teleportal";
import { FanOutReader } from "teleportal/transports";
import { Connection, ConnectionOptions, ConnectionState } from "./connection";
import { HttpConnection } from "./http/connection";
import { WebSocketConnection } from "./websocket/connection";

export type FallbackConnectionOptions = {
  /**
   * The base URL for both WebSocket and HTTP connections
   * WebSocket will use ws:// or wss:// prefix
   * HTTP will use the URL as-is
   */
  url: string;
  /**
   * Timeout in milliseconds for WebSocket connection attempts
   * @default 2000
   */
  websocketTimeout?: number;
  /**
   * WebSocket-specific options
   */
  websocketOptions?: {
    protocols?: string[];
    WebSocket?: typeof WebSocket;
  };
  /**
   * HTTP-specific options
   */
  httpOptions?: {
    fetch?: typeof fetch;
    EventSource?: typeof EventSource;
  };
} & ConnectionOptions;

type FallbackContext = {
  connected: {
    connectionType: "websocket" | "http";
    underlyingContext: any;
  };
  disconnected: {
    connectionType: "websocket" | "http" | null;
    lastFailedConnectionType?: "websocket" | "http";
    underlyingContext: any;
  };
  connecting: {
    connectionType: "websocket" | "http";
    underlyingContext: any;
  };
  errored: {
    connectionType: "websocket" | "http" | null;
    lastFailedConnectionType?: "websocket" | "http";
    underlyingContext: any;
    reconnectAttempt: number;
  };
};

export class FallbackConnection extends Connection<FallbackContext> {
  #baseUrl: string;
  #websocketTimeout: number;
  #websocketOptions: Required<FallbackConnectionOptions>["websocketOptions"];
  #httpOptions: Required<FallbackConnectionOptions>["httpOptions"];
  #currentConnection: WebSocketConnection | HttpConnection | null = null;
  #reader: FanOutReader<RawReceivedMessage> | null = null;
  #websocketConnectionStatus: "init" | "failed" | "success" = "init";
  #connectionAttemptId: number = 0;

  constructor(options: FallbackConnectionOptions) {
    super(options);

    this.#baseUrl = options.url;
    this.#websocketTimeout = options.websocketTimeout ?? 2000;
    this.#websocketOptions = options.websocketOptions ?? {};
    this.#httpOptions = options.httpOptions ?? {};

    // Initialize state
    this._state = {
      type: "disconnected",
      context: {
        connectionType: null,
        underlyingContext: null,
      },
    };
  }

  private getWebSocketUrl(baseUrl: string): string {
    const url = new URL(baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }

  private getHttpUrl(baseUrl: string): string {
    return new URL(baseUrl).toString();
  }

  protected async initConnection(): Promise<void> {
    if (this.destroyed) {
      throw new Error("FallbackConnection is destroyed, create a new instance");
    }

    if (!this.shouldAttemptConnection()) {
      return;
    }

    // Prevent concurrent connection attempts - only use state
    if (this.state.type === "connecting" || this.state.type === "connected") {
      return;
    }

    const currentAttemptId = ++this.#connectionAttemptId;

    try {
      // Clean up any existing connection before starting new one
      await this.cleanupCurrentConnection();

      // If WebSocket hasn't failed yet, try WebSocket first
      if (this.#websocketConnectionStatus === "init") {
        try {
          await this.tryWebSocketConnection(currentAttemptId);
          if (currentAttemptId === this.#connectionAttemptId) {
            this.#websocketConnectionStatus = "success";
            return;
          }
        } catch (error) {
          // Only handle the error if this is still the current attempt
          if (currentAttemptId === this.#connectionAttemptId) {
            this.#websocketConnectionStatus = "failed";
            // Continue to HTTP fallback
          } else {
            // This attempt was superseded, don't continue
            return;
          }
        }
      }

      // Try HTTP connection only if this is still the current attempt
      if (currentAttemptId === this.#connectionAttemptId) {
        try {
          await this.tryHttpConnection(currentAttemptId);
        } catch (error) {
          if (currentAttemptId === this.#connectionAttemptId) {
            this.handleConnectionError(
              error instanceof Error ? error : new Error(String(error)),
            );
          }
        }
      }
    } catch (error) {
      if (currentAttemptId === this.#connectionAttemptId) {
        this.handleConnectionError(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
  }

  private async cleanupCurrentConnection(): Promise<void> {
    if (this.#reader) {
      this.#reader.unsubscribe();
      this.#reader = null;
    }

    if (this.#currentConnection) {
      await this.#currentConnection.destroy();
      this.#currentConnection = null;
    }
  }

  private async tryWebSocketConnection(attemptId: number): Promise<void> {
    const wsUrl = this.getWebSocketUrl(this.#baseUrl);
    const wsConnection = new WebSocketConnection({
      url: wsUrl,
      protocols: this.#websocketOptions.protocols,
      WebSocket: this.#websocketOptions.WebSocket,
      connect: false, // We'll connect manually
    });

    // Check if attempt is still valid
    if (attemptId !== this.#connectionAttemptId) {
      await wsConnection.destroy();
      throw new Error("Connection attempt superseded");
    }

    this.setState({
      type: "connecting",
      context: {
        connectionType: "websocket",
        underlyingContext: wsConnection.state.context,
      },
    });

    // Set up connection monitoring
    this.setupConnectionEventHandlers(wsConnection, "websocket", attemptId);

    let timeout: ReturnType<typeof setTimeout> | null = null;
    let isTimedOut = false;

    try {
      // Try to connect with timeout
      const connectPromise = wsConnection.connect().catch((e) => {
        // ignore websocket errors if we haven't failed it yet or if timed out
        if (!isTimedOut && attemptId === this.#connectionAttemptId) {
          throw e;
        }
        return new Promise(() => {
          // Purposefully never resolve so that we wait for the timeout
        });
      });

      const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          isTimedOut = true;
          wsConnection.destroy().finally(() => {
            reject(new Error("WebSocket connection timeout"));
          });
        }, this.#websocketTimeout);
      });

      await Promise.race([connectPromise, timeoutPromise]);

      // Check if attempt is still valid after connection
      if (attemptId !== this.#connectionAttemptId) {
        await wsConnection.destroy();
        throw new Error("Connection attempt superseded");
      }

      // If we get here, WebSocket connected successfully
      this.#reader = wsConnection.getReader();
      this.setupMessagePipe();
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private async tryHttpConnection(attemptId: number): Promise<void> {
    const httpUrl = this.getHttpUrl(this.#baseUrl);
    const httpConnection = new HttpConnection({
      url: httpUrl,
      fetch: this.#httpOptions.fetch,
      EventSource: this.#httpOptions.EventSource,
      connect: false, // We'll connect manually
    });

    // Check if attempt is still valid
    if (attemptId !== this.#connectionAttemptId) {
      await httpConnection.destroy();
      throw new Error("Connection attempt superseded");
    }

    this.setState({
      type: "connecting",
      context: {
        connectionType: "http",
        underlyingContext: httpConnection.state.context,
      },
    });

    // Set up connection monitoring
    this.setupConnectionEventHandlers(httpConnection, "http", attemptId);

    await httpConnection.connect();

    // Check if attempt is still valid after connection
    if (attemptId !== this.#connectionAttemptId) {
      await httpConnection.destroy();
      throw new Error("Connection attempt superseded");
    }

    this.#reader = httpConnection.getReader();
    this.setupMessagePipe();
  }

  private setupConnectionEventHandlers(
    connection: WebSocketConnection | HttpConnection,
    type: "websocket" | "http",
    attemptId: number,
  ): void {
    connection.addListeners({
      update: (state) => {
        // Only handle updates if this is still the current attempt
        if (attemptId !== this.#connectionAttemptId) {
          return;
        }

        if (state.type === "errored") {
          if (
            this.#websocketConnectionStatus === "init" &&
            type === "websocket"
          ) {
            // ignore websocket errors if we haven't failed it yet
            return;
          }

          this.handleConnectionError(
            state.error,
            state.context?.reconnectAttempt,
          );
          return;
        }

        this.setState({
          type: state.type,
          context: {
            connectionType: type,
            underlyingContext: state.context,
          },
        } as ConnectionState<FallbackContext>);
      },
      message: (message) => {
        // Only handle messages if this is still the current attempt
        if (attemptId === this.#connectionAttemptId) {
          this.call("message", message);
        }
      },
      connected: () => {
        // Only handle connection if this is still the current attempt
        if (attemptId === this.#connectionAttemptId) {
          this.#currentConnection = connection;
          this.call("connected");
        }
      },
      disconnected: () => {
        // Only handle disconnection if this is still the current attempt
        if (attemptId === this.#connectionAttemptId) {
          this.call("disconnected");
          // Clean up the reader when disconnected
          if (this.#reader) {
            this.#reader.unsubscribe();
            this.#reader = null;
          }
        }
      },
      ping: () => {
        // Only handle ping if this is still the current attempt
        if (attemptId === this.#connectionAttemptId) {
          this.call("ping");
        }
      },
    });
  }

  private setupMessagePipe(): Promise<void> {
    if (!this.#reader) {
      return Promise.resolve();
    }

    // Pipe messages from the underlying connection to our writer
    return this.#reader.readable
      .pipeTo(
        new WritableStream({
          write: async (message) => {
            this.updateLastMessageReceived();
            await this.writer.write(message);
          },
        }),
      )
      .catch((error) => {
        // no-op
      });
  }

  protected async sendMessage(message: Message): Promise<void> {
    if (!this.#currentConnection) {
      throw new Error("No active connection");
    }
    await this.#currentConnection.send(message);
  }

  protected async closeConnection(): Promise<void> {
    // Increment connection attempt ID to cancel any ongoing attempts
    this.#connectionAttemptId++;

    await this.cleanupCurrentConnection();

    this.setState({
      type: "disconnected",
      context: {
        connectionType: this.state.context.connectionType,
        underlyingContext: null,
      },
    });
  }

  public async destroy(): Promise<void> {
    if (this.destroyed) {
      return;
    }

    // Increment connection attempt ID to cancel any ongoing attempts
    this.#connectionAttemptId++;

    await this.cleanupCurrentConnection();

    await super.destroy();
  }

  public get connectionType(): "websocket" | "http" | null {
    return this.state.context.connectionType;
  }

  /**
   * Override the connect method to throw the correct error message
   */
  public async connect(): Promise<void> {
    if (this.destroyed) {
      throw new Error("FallbackConnection is destroyed, create a new instance");
    }
    return super.connect();
  }

  /**
   * Reset WebSocket connection status to allow retrying WebSocket on reconnection
   */
  public resetWebSocketStatus(): void {
    this.#websocketConnectionStatus = "init";
  }

  /**
   * Override disconnect to reset WebSocket status for fresh reconnection attempts
   */
  public async disconnect(): Promise<void> {
    if (this.destroyed) {
      throw new Error("Connection is destroyed, create a new instance");
    }

    // Reset WebSocket status when explicitly disconnecting
    this.#websocketConnectionStatus = "init";

    // Call parent disconnect method to handle base logic
    await super.disconnect();
  }
}
