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
   * @default 5000
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
  #websocketFailed = false;

  constructor(options: FallbackConnectionOptions) {
    super(options);

    this.#baseUrl = options.url;
    this.#websocketTimeout = options.websocketTimeout ?? 5000;
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
    return this.#baseUrl;
  }

  protected async initConnection(): Promise<void> {
    if (this.destroyed) {
      throw new Error("FallbackConnection is destroyed, create a new instance");
    }

    if (!this.shouldAttemptConnection()) {
      return;
    }

    // If WebSocket hasn't failed yet, try WebSocket first
    if (!this.#websocketFailed) {
      try {
        await this.tryWebSocketConnection();
        return;
      } catch (error) {
        console.warn(
          "WebSocket connection failed, falling back to HTTP:",
          error,
        );
        this.#websocketFailed = true;
        // Continue to HTTP fallback
      }
    }

    // Try HTTP connection
    try {
      await this.tryHttpConnection();
    } catch (error) {
      this.handleConnectionError(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  private async tryWebSocketConnection(): Promise<void> {
    const wsUrl = this.getWebSocketUrl(this.#baseUrl);
    const wsConnection = new WebSocketConnection({
      url: wsUrl,
      protocols: this.#websocketOptions.protocols,
      WebSocket: this.#websocketOptions.WebSocket,
      connect: false, // We'll connect manually
    });

    this.setState({
      type: "connecting",
      context: {
        connectionType: "websocket",
        underlyingContext: wsConnection.state.context,
      },
    });

    // Set up connection monitoring
    this.setupConnectionEventHandlers(wsConnection, "websocket");

    // Try to connect with timeout
    const connectPromise = wsConnection.connect();
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error("WebSocket connection timeout")),
        this.#websocketTimeout,
      );
    });

    await Promise.race([connectPromise, timeoutPromise]);

    // If we get here, WebSocket connected successfully
    this.#currentConnection = wsConnection;
    this.#reader = wsConnection.getReader();
    this.setupMessagePipe();
  }

  private async tryHttpConnection(): Promise<void> {
    const httpUrl = this.getHttpUrl(this.#baseUrl);
    const httpConnection = new HttpConnection({
      url: httpUrl,
      fetch: this.#httpOptions.fetch,
      EventSource: this.#httpOptions.EventSource,
      connect: false, // We'll connect manually
    });

    this.setState({
      type: "connecting",
      context: {
        connectionType: "http",
        underlyingContext: httpConnection.state.context,
      },
    });

    // Set up connection monitoring
    this.setupConnectionEventHandlers(httpConnection, "http");

    await httpConnection.connect();

    this.#currentConnection = httpConnection;
    this.#reader = httpConnection.getReader();
    this.setupMessagePipe();
  }

  private setupConnectionEventHandlers(
    connection: WebSocketConnection | HttpConnection,
    type: "websocket" | "http",
  ): void {
    connection.on("update", (state) => {
      if (state.type === "errored") {
        this.handleConnectionError(
          (state as any).error,
          (state as any).context?.reconnectAttempt,
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
    });

    connection.on("message", (message) => {
      this.call("message", message);
    });

    connection.on("connected", () => {
      this.call("connected");
    });

    connection.on("disconnected", () => {
      this.call("disconnected");
      // Clean up the reader when disconnected
      if (this.#reader) {
        this.#reader.unsubscribe();
        this.#reader = null;
      }
    });
  }

  private setupMessagePipe(): void {
    if (!this.#reader) return;

    // Pipe messages from the underlying connection to our writer
    this.#reader.readable
      .pipeTo(
        new WritableStream({
          write: async (message) => {
            this.updateLastMessageReceived();
            await this.writer.write(message);
          },
        }),
      )
      .catch((error) => {
        // Handle pipe errors
        console.warn("Message pipe error:", error);
      });
  }

  protected async sendMessage(message: Message): Promise<void> {
    if (!this.#currentConnection) {
      throw new Error("No active connection");
    }
    await this.#currentConnection.send(message);
  }

  protected sendHeartbeat(): void {
    if (this.#currentConnection && this.state.type === "connected") {
      // Delegate to the underlying connection
      (this.#currentConnection as any).sendHeartbeat?.();
    }
  }

  protected async closeConnection(): Promise<void> {
    if (this.#reader) {
      this.#reader.unsubscribe();
      this.#reader = null;
    }

    if (this.#currentConnection) {
      await this.#currentConnection.destroy();
      this.#currentConnection = null;
    }

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

    if (this.#currentConnection) {
      await this.#currentConnection.destroy();
      this.#currentConnection = null;
    }

    if (this.#reader) {
      this.#reader.unsubscribe();
      this.#reader = null;
    }

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
   * Override error handling to trigger fallback logic
   */
  protected handleConnectionError(error: Error, reconnectAttempt?: number) {
    // If we haven't already failed WebSocket, treat this as a WebSocket failure and fallback to HTTP
    if (
      !this.#websocketFailed &&
      this.state.context.connectionType === "websocket"
    ) {
      this.#websocketFailed = true;
      // Try HTTP connection immediately
      this.initConnection();
      return;
    }
    // If HTTP also fails, call the base class handler
    super.handleConnectionError(error, reconnectAttempt);
  }
}
