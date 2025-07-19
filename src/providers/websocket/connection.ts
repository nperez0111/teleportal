import {
  decodeMessage,
  encodePingMessage,
  isBinaryMessage,
  isPongMessage,
  type Message,
  Observable,
  type RawReceivedMessage,
} from "teleportal";
import { createFanOutWriter, FanOutReader } from "teleportal/transports";
import type { Connection, ConnectionState } from "../connection";
import { ExponentialBackoff } from "../utils";

const MESSAGE_RECONNECT_TIMEOUT = 30000;
const HEARTBEAT_INTERVAL = 10000;
const INITIAL_RECONNECT_DELAY = 100;
const MAX_RECONNECT_ATTEMPTS = 10;
const MAX_BACKOFF_TIME = 30000;

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

export class WebSocketConnection
  extends Observable<{
    update: (state: ConnectionState<WebSocketConnectContext>) => void;
    message: (message: Message) => void;
    connected: () => void;
    disconnected: () => void;
  }>
  implements Connection<WebSocketConnectContext>
{
  // Static timer functions that can be overridden for testing
  static setTimeout = globalThis.setTimeout.bind(globalThis);
  static setInterval = globalThis.setInterval.bind(globalThis);
  static clearTimeout = globalThis.clearTimeout.bind(globalThis);
  static clearInterval = globalThis.clearInterval.bind(globalThis);
  static location: { hostname: string } | undefined = globalThis.location;

  #wsLastMessageReceived = 0;
  #shouldConnect = true;
  #disconnected = false;
  #isOnline: boolean = true;
  #heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  #checkInterval: ReturnType<typeof setInterval> | null = null;
  #reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  #url: string;
  #protocols: string[];
  #state: ConnectionState<WebSocketConnectContext> = {
    type: "disconnected",
    context: { ws: null },
  };

  #setState(state: ConnectionState<WebSocketConnectContext>) {
    this.#state = state;
    this.call("update", state);
    switch (state.type) {
      case "connected":
        this.call("connected");
        break;
      case "disconnected":
        this.call("disconnected");
        break;
    }
  }

  #reconnectAttempt = 0;
  #WebSocketImpl: typeof WebSocket;
  #backoff: ExponentialBackoff;
  #messageBuffer: Message[] = [];
  #maxReconnectAttempts: number;
  #eventTarget: EventTarget;
  #onlineHandler: (() => void) | null = null;
  #offlineHandler: (() => void) | null = null;

  /**
   * Given a single writer (the incoming websocket messages), this will fan out to all connected readers
   */
  #fanOutWriter = createFanOutWriter<RawReceivedMessage>();
  #writer = this.#fanOutWriter.writable.getWriter();

  /**
   * A writable stream to send messages over the websocket connection
   */
  public writable: WritableStream<Message> = new WritableStream({
    write: (message) => {
      this.send(message);
    },
  });

  public destroyed = false;

  constructor({
    url,
    protocols = [],
    connect = true,
    WebSocket: WebSocketImpl = WebSocket,
    maxReconnectAttempts = MAX_RECONNECT_ATTEMPTS,
    initialReconnectDelay = INITIAL_RECONNECT_DELAY,
    maxBackoffTime = MAX_BACKOFF_TIME,
    eventTarget,
    isOnline,
  }: {
    url: string;
    protocols?: string[];
    connect?: boolean;
    WebSocket?: typeof WebSocket;
    maxReconnectAttempts?: number;
    initialReconnectDelay?: number;
    maxBackoffTime?: number;
    eventTarget?: EventTarget;
    isOnline?: boolean;
  }) {
    super();
    this.#url = url;
    this.#protocols = protocols;
    this.#WebSocketImpl = WebSocketImpl;

    if (typeof window !== "undefined") {
      this.#eventTarget = eventTarget ?? window;
      this.#isOnline =
        (isOnline ?? WebSocketConnection.location?.hostname !== "localhost")
          ? (navigator.onLine ?? true)
          : true;
    } else {
      this.#eventTarget = eventTarget ?? new EventTarget();
      this.#isOnline = isOnline ?? true;
    }

    // Calculate max exponent for exponential backoff
    const maxExponent = Math.floor(
      Math.log2(maxBackoffTime / initialReconnectDelay),
    );
    this.#backoff = new ExponentialBackoff(initialReconnectDelay, maxExponent);
    this.#maxReconnectAttempts = maxReconnectAttempts;

    // Set up online/offline event listeners
    if (WebSocketConnection.location?.hostname !== "localhost") {
      this.#setupOnlineOfflineListeners();
    }

    if (connect) {
      this.connect();
    }

    this.#setupHeartbeat();
    this.#setupConnectionCheck();
  }

  #setupOnlineOfflineListeners() {
    const handleOnline = () => {
      this.#isOnline = true;

      // If we were disconnected due to being offline and should connect, try to reconnect
      if (
        this.#shouldConnect &&
        !this.#disconnected &&
        this.state.type === "disconnected"
      ) {
        this.#backoff.reset();
        this.#reconnectAttempt++;
        this.#setupWebSocket();
      }
    };

    const handleOffline = () => {
      this.#isOnline = false;

      // Cancel any pending reconnection attempts when going offline
      if (this.#reconnectTimeout) {
        clearTimeout(this.#reconnectTimeout);
        this.#reconnectTimeout = null;
      }
    };

    // Add event listeners
    this.#eventTarget.addEventListener("online", handleOnline);
    this.#eventTarget.addEventListener("offline", handleOffline);

    // Store references for cleanup
    this.#onlineHandler = handleOnline;
    this.#offlineHandler = handleOffline;
  }

  #setupHeartbeat() {
    this.#heartbeatInterval = WebSocketConnection.setInterval(() => {
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
    }, HEARTBEAT_INTERVAL);
  }

  #setupConnectionCheck() {
    this.#checkInterval = WebSocketConnection.setInterval(() => {
      if (
        this.state.type === "connected" &&
        MESSAGE_RECONNECT_TIMEOUT < Date.now() - this.#wsLastMessageReceived
      ) {
        this.#handleConnectionTimeout();
      }
    }, MESSAGE_RECONNECT_TIMEOUT / 10);
  }

  #handleConnectionTimeout() {
    const error = new Error(
      "WebSocket connection timeout - no messages received",
    );
    this.#setState({
      type: "errored",
      context: { reconnectAttempt: this.#reconnectAttempt },
      error,
    });
    this.#closeWebSocketConnection();
  }

  #setupWebSocket() {
    if (this.destroyed) {
      throw new Error(
        "WebSocketConnection is destroyed, create a new instance",
      );
    }
    if (!this.#shouldConnect) {
      return;
    }

    // Don't attempt to connect if we're offline
    if (!this.#isOnline) {
      return;
    }

    try {
      const websocket = new this.#WebSocketImpl(this.#url, this.#protocols);
      websocket.binaryType = "arraybuffer";
      this.#setState({ type: "connecting", context: { ws: websocket } });

      websocket.addEventListener("message", async (event) => {
        this.#wsLastMessageReceived = Date.now();
        const message = new Uint8Array(event.data as ArrayBuffer);

        if (!isBinaryMessage(message)) {
          const error = new Error("Invalid message", { cause: event });
          this.#setState({
            type: "errored",
            context: { reconnectAttempt: this.#reconnectAttempt },
            error,
          });
          return;
        }

        if (isPongMessage(message)) {
          return;
        }

        try {
          const decodedMessage = decodeMessage(message);
          await this.#writer.write(decodedMessage);
          this.call("message", decodedMessage);
        } catch (err) {
          const error = new Error(
            "Failed to write message to internal stream",
            {
              cause: err,
            },
          );
          this.#setState({
            type: "errored",
            context: { reconnectAttempt: this.#reconnectAttempt },
            error,
          });
          this.#closeWebSocketConnection();
        }
      });

      websocket.addEventListener("error", (event) => {
        const error = new Error("WebSocket error", { cause: event });
        this.#setState({
          type: "errored",
          context: { reconnectAttempt: this.#reconnectAttempt },
          error,
        });
      });

      websocket.addEventListener("close", () => {
        this.#closeWebSocketConnection();
      });

      websocket.addEventListener("open", () => {
        this.#wsLastMessageReceived = Date.now();
        this.#setState({ type: "connected", context: { ws: websocket } });
        this.#sendBufferedMessages();
      });
    } catch (error) {
      this.#setState({
        type: "errored",
        context: { reconnectAttempt: this.#reconnectAttempt },
        error: error instanceof Error ? error : new Error(String(error)),
      });
      this.#scheduleReconnect();
    }
  }

  #scheduleReconnect() {
    if (this.#reconnectTimeout) {
      WebSocketConnection.clearTimeout(this.#reconnectTimeout);
    }

    // Don't schedule reconnection if:
    // - We shouldn't connect
    // - We're destroyed
    // - We're manually disconnected
    // - We're offline
    if (
      !this.#shouldConnect ||
      this.destroyed ||
      this.#disconnected ||
      !this.#isOnline
    ) {
      return;
    }

    // Use exponential backoff for delay calculation
    const delay = this.#backoff.next();

    this.#reconnectTimeout = WebSocketConnection.setTimeout(() => {
      if (this.#reconnectAttempt >= this.#maxReconnectAttempts) {
        this.#setState({
          type: "errored",
          context: { reconnectAttempt: this.#reconnectAttempt },
          error: new Error("Maximum reconnection attempts reached"),
        });
        return;
      }

      this.#reconnectAttempt++;
      this.#setupWebSocket();
    }, delay);
  }

  #closeWebSocketConnection() {
    if (this.state.type === "connected" || this.state.type === "connecting") {
      this.state.context.ws.close();
      const wasConnected = this.state.type === "connected";
      this.#setState({ type: "disconnected", context: { ws: null } });

      if (
        !this.#disconnected &&
        this.#isOnline &&
        (wasConnected || this.#shouldConnect)
      ) {
        this.#scheduleReconnect();
      }
    }
  }

  #sendBufferedMessages() {
    // Send any buffered messages when connection is established
    while (this.#messageBuffer.length > 0) {
      const message = this.#messageBuffer.shift();
      if (message) {
        this.send(message);
      }
    }
  }

  send(message: Message): void {
    if (this.destroyed) {
      throw new Error(
        "WebSocketConnection is destroyed, create a new instance",
      );
    }

    if (this.#disconnected) {
      return; // Don't send if manually disconnected
    }

    if (
      this.state.type === "connected" &&
      this.state.context.ws.readyState === this.#WebSocketImpl.OPEN
    ) {
      try {
        this.state.context.ws.send(message.encoded);
      } catch (err) {
        const error =
          err instanceof Error
            ? err
            : new Error("Failed to send message", { cause: err });
        this.#setState({
          type: "errored",
          context: { reconnectAttempt: this.#reconnectAttempt },
          error,
        });
        this.#closeWebSocketConnection();
        throw error;
      }
    } else {
      // Buffer message if not connected
      this.#messageBuffer.push(message);
    }
  }

  async connect(): Promise<void> {
    if (this.destroyed) {
      throw new Error(
        "WebSocketConnection is destroyed, create a new instance",
      );
    }
    this.#shouldConnect = true;
    this.#disconnected = false;
    this.#reconnectAttempt = 0;
    this.#backoff.reset();
    if (this.state.type === "disconnected" && this.#isOnline) {
      this.#setupWebSocket();
    }
    return this.connected;
  }

  async disconnect(): Promise<void> {
    if (this.destroyed) {
      throw new Error(
        "WebSocketConnection is destroyed, create a new instance",
      );
    }
    this.#shouldConnect = false;
    this.#disconnected = true;
    if (this.#reconnectTimeout) {
      clearTimeout(this.#reconnectTimeout);
    }
    if (this.state.type === "connected" || this.state.type === "connecting") {
      this.#closeWebSocketConnection();
    }
  }

  get state(): ConnectionState<WebSocketConnectContext> {
    return this.#state;
  }

  getReader(): FanOutReader<RawReceivedMessage> {
    return this.#fanOutWriter.getReader();
  }

  get connected(): Promise<void> {
    const currentState = this.state;
    switch (currentState.type) {
      case "disconnected":
      case "connecting": {
        return new Promise((resolve, reject) => {
          let handled = false;
          const unsubscribe = this.on("update", (state) => {
            if (!handled) {
              if (state.type === "connected") {
                handled = true;
                unsubscribe();
                resolve();
              } else if (state.type === "errored") {
                handled = true;
                unsubscribe();
                reject(state.error);
              }
            }
          });
        });
      }
      case "connected": {
        return Promise.resolve();
      }
      case "errored": {
        return Promise.reject(currentState.error);
      }
    }
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    super.destroy();
    this.destroyed = true;

    // Clean up online/offline listeners
    if (this.#onlineHandler) {
      this.#eventTarget.removeEventListener("online", this.#onlineHandler);
    }
    if (this.#offlineHandler) {
      this.#eventTarget.removeEventListener("offline", this.#offlineHandler);
    }

    if (this.#heartbeatInterval) {
      WebSocketConnection.clearInterval(this.#heartbeatInterval);
    }
    if (this.#checkInterval) {
      WebSocketConnection.clearInterval(this.#checkInterval);
    }
    if (this.#reconnectTimeout) {
      WebSocketConnection.clearTimeout(this.#reconnectTimeout);
    }

    this.#shouldConnect = false;
    this.#disconnected = true;
    this.#messageBuffer.length = 0; // Clear the array

    if (this.state.type === "connected" || this.state.type === "connecting") {
      this.#closeWebSocketConnection();
    }

    this.#writer.close();
  }

  [Symbol.dispose]() {
    this.destroy();
  }
}
