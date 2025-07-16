import { Observable } from "teleportal";
import {
  encodePingMessage,
  isPongMessage,
  type BinaryMessage,
} from "teleportal";
import { createFanOutWriter } from "../../transports/utils";

const MESSAGE_RECONNECT_TIMEOUT = 30000;
const HEARTBEAT_INTERVAL = 10000;
const INITIAL_RECONNECT_DELAY = 100;
const MAX_RECONNECT_ATTEMPTS = 10;
const MAX_BACKOFF_TIME = 30000; // Increased from 2500ms to 30s for better exponential backoff

/**
 * Exponential backoff implementation inspired by websocket-ts
 */
class ExponentialBackoff {
  private readonly base: number;
  private readonly maxExponent?: number;
  private i: number = 0;
  private _retries: number = 0;

  constructor(base: number, maxExponent?: number) {
    if (!Number.isInteger(base) || base < 0) {
      throw new Error("Base must be a positive integer or zero");
    }
    if (
      maxExponent !== undefined &&
      (!Number.isInteger(maxExponent) || maxExponent < 0)
    ) {
      throw new Error(
        "MaxExponent must be undefined, a positive integer or zero",
      );
    }

    this.base = base;
    this.maxExponent = maxExponent;
  }

  get retries(): number {
    return this._retries;
  }

  get current(): number {
    return this.base * Math.pow(2, this.i);
  }

  next(): number {
    this._retries++;
    this.i =
      this.maxExponent === undefined
        ? this.i + 1
        : Math.min(this.i + 1, this.maxExponent);
    return this.current;
  }

  reset(): void {
    this._retries = 0;
    this.i = 0;
  }
}

export type WebsocketState =
  | {
      type: "offline";
      ws: null;
    }
  | {
      type: "connecting";
      ws: WebSocket;
    }
  | {
      type: "connected";
      ws: WebSocket;
    }
  | {
      type: "error";
      ws: WebSocket | null;
      error: Error;
      reconnectAttempt: number;
    };

export class WebsocketConnection extends Observable<{
  update: (state: WebsocketState) => void;
  message: (message: BinaryMessage) => void;
  close: (event: CloseEvent) => void;
  open: () => void;
  error: (error: Error) => void;
  reconnect: () => void;
  retry: (attempt: number, delay: number) => void;
  online: () => void;
  offline: () => void;
}> {
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
  #state: WebsocketState = { type: "offline", ws: null };
  #reconnectAttempt = 0;
  #WebSocketImpl: typeof WebSocket;
  #backoff: ExponentialBackoff;
  #messageBuffer: BinaryMessage[] = [];
  #maxReconnectAttempts: number;
  #lastConnection?: Date;
  #eventTarget: EventTarget;
  #onlineHandler: (() => void) | null = null;
  #offlineHandler: (() => void) | null = null;

  /**
   * Given a single writer (the incoming websocket messages), this will fan out to all connected readers
   */
  #fanOutWriter = createFanOutWriter();

  /**
   * A writable stream to send messages over the websocket connection
   */
  public writable: WritableStream<BinaryMessage> = new WritableStream({
    write: (message) => {
      this.send(message);
    },
  });

  /**
   * Whether the websocket connection has been destroyed
   */
  public isDestroyed = false;

  /**
   * @returns a promise that resolves when the websocket is connected
   */
  public get connected(): Promise<void> {
    switch (this.state.type) {
      case "offline":
      case "connecting": {
        return new Promise((resolve, reject) => {
          let handled = false;
          this.once("close", () => {
            if (!handled) {
              handled = true;
              reject(new Error("WebSocket closed"));
            }
          });
          this.once("open", () => {
            if (!handled) {
              handled = true;
              resolve();
            }
          });
        });
      }
      case "connected": {
        return Promise.resolve();
      }

      default: {
        return Promise.reject(
          new Error(`WebSocket is in an invalid state: ${this.state.type}`),
        );
      }
    }
  }

  public get state() {
    return this.#state;
  }

  public set state(state: WebsocketState) {
    this.#state = state;
    this.call("update", state);
    switch (state.type) {
      case "error": {
        this.call("error", state.error);
        break;
      }
      case "connected": {
        if (this.#reconnectAttempt > 0) {
          this.#reconnectAttempt = 0;
          this.#backoff.reset();
          this.call("reconnect");
        }
        this.#lastConnection = new Date();
        this.call("open");
        break;
      }
    }
  }

  /**
   * Get the last connection timestamp
   */
  public get lastConnection(): Date | undefined {
    return this.#lastConnection;
  }

  /**
   * Check if the device is currently online
   */
  public get isOnline(): boolean {
    return this.#isOnline;
  }

  /**
   * Check if the connection was manually disconnected
   */
  public get disconnected(): boolean {
    return this.#disconnected;
  }

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
        (isOnline ?? WebsocketConnection.location?.hostname !== "localhost")
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
    if (WebsocketConnection.location?.hostname !== "localhost") {
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
      this.call("online");

      // If we were disconnected due to being offline and should connect, try to reconnect
      if (
        this.#shouldConnect &&
        !this.#disconnected &&
        this.state.type === "offline"
      ) {
        this.#backoff.reset();
        this.#reconnectAttempt++;
        this._setupWebSocket();
      }
    };

    const handleOffline = () => {
      this.#isOnline = false;
      this.call("offline");

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
    this.#heartbeatInterval = WebsocketConnection.setInterval(() => {
      if (this.state.type === "connected") {
        this.send(encodePingMessage());
      }
    }, HEARTBEAT_INTERVAL);
  }

  #setupConnectionCheck() {
    this.#checkInterval = WebsocketConnection.setInterval(() => {
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
    this.state = {
      type: "error",
      ws: this.state.ws,
      error,
      reconnectAttempt: this.#reconnectAttempt,
    };
    this.#closeWebSocketConnection();
  }

  private _setupWebSocket() {
    if (this.isDestroyed) {
      throw new Error("WebsocketClient is destroyed, create a new instance");
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
      this.state = { type: "connecting", ws: websocket };

      websocket.addEventListener("message", async (event) => {
        this.#wsLastMessageReceived = Date.now();
        const message = new Uint8Array(
          event.data as ArrayBuffer,
        ) as BinaryMessage;

        if (isPongMessage(message)) {
          return;
        }

        try {
          await this.#fanOutWriter.writer.write(message);
          this.call("message", message);
        } catch (err) {
          const error = new Error(
            "Failed to write message to internal stream",
            {
              cause: err,
            },
          );
          this.state = {
            type: "error",
            ws: websocket,
            error,
            reconnectAttempt: this.#reconnectAttempt,
          };
          this.#closeWebSocketConnection();
        }
      });

      websocket.addEventListener("error", (event) => {
        const error = new Error("WebSocket error", { cause: event });
        this.state = {
          type: "error",
          ws: websocket,
          error,
          reconnectAttempt: this.#reconnectAttempt,
        };
      });

      websocket.addEventListener("close", (event) => {
        this.#closeWebSocketConnection();
        this.call("close", event);
      });

      websocket.addEventListener("open", () => {
        this.#wsLastMessageReceived = Date.now();
        this.state = { type: "connected", ws: websocket };
        this.#sendBufferedMessages();
      });
    } catch (error) {
      this.state = {
        type: "error",
        ws: null,
        error: error instanceof Error ? error : new Error(String(error)),
        reconnectAttempt: this.#reconnectAttempt,
      };
      this.#scheduleReconnect();
    }
  }

  #scheduleReconnect() {
    if (this.#reconnectTimeout) {
      WebsocketConnection.clearTimeout(this.#reconnectTimeout);
    }

    // Don't schedule reconnection if:
    // - We shouldn't connect
    // - We're destroyed
    // - We're manually disconnected
    // - We're offline
    if (
      !this.#shouldConnect ||
      this.isDestroyed ||
      this.#disconnected ||
      !this.#isOnline
    ) {
      return;
    }

    // Use exponential backoff for delay calculation
    const delay = this.#backoff.next();

    // Emit retry event with attempt info
    this.call("retry", this.#reconnectAttempt + 1, delay);

    this.#reconnectTimeout = WebsocketConnection.setTimeout(() => {
      if (this.#reconnectAttempt >= this.#maxReconnectAttempts) {
        this.state = {
          type: "error",
          ws: null,
          error: new Error("Maximum reconnection attempts reached"),
          reconnectAttempt: this.#reconnectAttempt,
        };
        return;
      }

      this.#reconnectAttempt++;
      this._setupWebSocket();
    }, delay);
  }

  #closeWebSocketConnection() {
    if (this.state.ws) {
      this.state.ws.close();
      const wasConnected = this.state.type === "connected";
      this.state = { type: "offline", ws: null };

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

  public send(data: BinaryMessage) {
    if (this.isDestroyed) {
      throw new Error("WebsocketClient is destroyed, create a new instance");
    }

    if (this.#disconnected) {
      return; // Don't send if manually disconnected
    }

    if (
      this.state.type === "connected" &&
      this.state.ws.readyState === this.#WebSocketImpl.OPEN
    ) {
      try {
        this.state.ws.send(data);
      } catch (err) {
        const error =
          err instanceof Error
            ? err
            : new Error("Failed to send message", { cause: err });
        this.state = {
          type: "error",
          ws: this.state.ws,
          error,
          reconnectAttempt: this.#reconnectAttempt,
        };
        this.#closeWebSocketConnection();
        throw error;
      }
    } else {
      // Buffer message if not connected
      this.#messageBuffer.push(data);
    }
  }

  public destroy() {
    if (this.isDestroyed) {
      return;
    }
    super.destroy();
    this.isDestroyed = true;

    this.#fanOutWriter.writer.close();

    // Clean up online/offline listeners
    if (this.#onlineHandler) {
      this.#eventTarget.removeEventListener("online", this.#onlineHandler);
    }
    if (this.#offlineHandler) {
      this.#eventTarget.removeEventListener("offline", this.#offlineHandler);
    }

    if (this.#heartbeatInterval) {
      WebsocketConnection.clearInterval(this.#heartbeatInterval);
    }
    if (this.#checkInterval) {
      WebsocketConnection.clearInterval(this.#checkInterval);
    }
    if (this.#reconnectTimeout) {
      WebsocketConnection.clearTimeout(this.#reconnectTimeout);
    }

    this.#shouldConnect = false;
    this.#disconnected = true;
    this.#messageBuffer.length = 0; // Clear the array

    if (this.state.ws) {
      this.#closeWebSocketConnection();
    }
  }

  [Symbol.dispose]() {
    this.destroy();
  }

  /**
   * Manually connect to the websocket connection
   */
  public connect() {
    if (this.isDestroyed) {
      throw new Error("WebsocketClient is destroyed, create a new instance");
    }
    this.#shouldConnect = true;
    this.#disconnected = false;
    this.#reconnectAttempt = 0;
    this.#backoff.reset();
    if (this.state.type === "offline" && this.#isOnline) {
      this._setupWebSocket();
    }
  }

  /**
   * Manually disconnect from the websocket connection
   */
  public disconnect() {
    if (this.isDestroyed) {
      throw new Error("WebsocketClient is destroyed, create a new instance");
    }
    this.#shouldConnect = false;
    this.#disconnected = true;
    if (this.#reconnectTimeout) {
      clearTimeout(this.#reconnectTimeout);
    }
    if (this.state.ws) {
      this.#closeWebSocketConnection();
    }
  }

  /**
   * Get a new reader to read incoming messages from the websocket connection
   */
  public getReader() {
    return this.#fanOutWriter.getReader();
  }
}
