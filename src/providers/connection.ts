import { Message, Observable, RawReceivedMessage } from "teleportal";
import { createFanOutWriter, FanOutReader } from "teleportal/transports";
import { ExponentialBackoff } from "./utils";

/**
 * The context of a {@link Connection}.
 */
export type ConnectionContext = {
  /**
   * The context of a connected {@link Connection}.
   */
  connected: Record<string, unknown>;
  /**
   * The context of a disconnected {@link Connection}.
   */
  disconnected: Record<string, unknown>;
  /**
   * The context of a connecting {@link Connection}.
   */
  connecting: Record<string, unknown>;
  /**
   * The context of an errored {@link Connection}.
   */
  errored: Record<string, unknown>;
};

/**
 * Represents the states that a {@link Connection} can be in.
 */
export type ConnectionState<Context extends ConnectionContext> =
  | {
      type: "connected";
      context: Context["connected"];
    }
  | {
      type: "disconnected";
      context: Context["disconnected"];
    }
  | {
      type: "connecting";
      context: Context["connecting"];
    }
  | {
      type: "errored";
      context: Context["errored"];
      error: Error;
    };

/**
 * Options for an instance of a {@link Connection}
 */
export type ConnectionOptions = {
  /**
   * Should the connection immediately connect
   *
   * @default true
   */
  connect?: boolean;
  /**
   * Maximum number of reconnection attempts
   *
   * @default 10
   */
  maxReconnectAttempts?: number;
  /**
   * Initial delay for reconnection attempts in milliseconds
   *
   * @default 100
   */
  initialReconnectDelay?: number;
  /**
   * Maximum backoff time in milliseconds
   *
   * @default 30000
   */
  maxBackoffTime?: number;
  /**
   * Event target for online/offline events
   *
   * @default window (browser) or new EventTarget() (node)
   */
  eventTarget?: EventTarget;
  /**
   * Whether the connection should be considered online
   *
   * @default true
   */
  isOnline?: boolean;
  /**
   * Heartbeat interval in milliseconds (0 to disable)
   *
   * This is the interval at which the connection will send a heartbeat message to the server (keeping the connection alive).
   *
   * @default 0 (disabled)
   */
  heartbeatInterval?: number;
  /**
   * Message reconnect timeout in milliseconds (0 to disable)
   *
   * This is the time after which the connection will be considered timed out if no messages have been received.
   *
   * @default 30000
   */
  messageReconnectTimeout?: number;
};

const DEFAULT_MAX_RECONNECT_ATTEMPTS = 10;
const DEFAULT_INITIAL_RECONNECT_DELAY = 100;
const DEFAULT_MAX_BACKOFF_TIME = 30000;
const DEFAULT_MESSAGE_RECONNECT_TIMEOUT = 30000;

export abstract class Connection<
  Context extends ConnectionContext,
> extends Observable<{
  update: (state: ConnectionState<Context>) => void;
  message: (message: Message) => void;
  connected: () => void;
  disconnected: () => void;
}> {
  // Static timer functions that can be overridden for testing
  static setTimeout = globalThis.setTimeout.bind(globalThis);
  static setInterval = globalThis.setInterval.bind(globalThis);
  static clearTimeout = globalThis.clearTimeout.bind(globalThis);
  static clearInterval = globalThis.clearInterval.bind(globalThis);
  static location: { hostname: string } | undefined = globalThis.location;

  // Reconnection state
  #reconnectAttempt = 0;
  #backoff: ExponentialBackoff;
  #maxReconnectAttempts: number;
  #reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  #shouldConnect = true;
  #disconnected = false;

  // Online/offline state
  #eventTarget: EventTarget;
  #isOnline: boolean = true;
  #onlineHandler: (() => void) | null = null;
  #offlineHandler: (() => void) | null = null;

  // Message buffering
  #messageBuffer: Message[] = [];

  // Heartbeat and connection check state
  #heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  #checkInterval: ReturnType<typeof setInterval> | null = null;
  #lastMessageReceived = 0;
  #heartbeatIntervalMs: number;
  #messageReconnectTimeoutMs: number;

  // Fan out writer for message distribution
  private fanOutWriter = createFanOutWriter<RawReceivedMessage>();
  protected writer = this.fanOutWriter.writable.getWriter();

  protected _state: ConnectionState<Context> = {
    type: "disconnected",
    context: {} as Context["disconnected"],
  };

  constructor({
    connect = true,
    maxReconnectAttempts = DEFAULT_MAX_RECONNECT_ATTEMPTS,
    initialReconnectDelay = DEFAULT_INITIAL_RECONNECT_DELAY,
    maxBackoffTime = DEFAULT_MAX_BACKOFF_TIME,
    eventTarget,
    isOnline,
    heartbeatInterval = 0,
    messageReconnectTimeout = DEFAULT_MESSAGE_RECONNECT_TIMEOUT,
  }: ConnectionOptions = {}) {
    super();

    // Initialize backoff strategy
    const maxExponent = Math.floor(
      Math.log2(maxBackoffTime / initialReconnectDelay),
    );
    this.#backoff = new ExponentialBackoff(initialReconnectDelay, maxExponent);
    this.#maxReconnectAttempts = maxReconnectAttempts;

    // Initialize heartbeat and connection check settings
    this.#heartbeatIntervalMs = heartbeatInterval;
    this.#messageReconnectTimeoutMs = messageReconnectTimeout;

    // Set up event target and online state
    if (typeof window !== "undefined") {
      this.#eventTarget = eventTarget ?? window;
      this.#isOnline =
        (isOnline ?? Connection.location?.hostname !== "localhost")
          ? (navigator.onLine ?? true)
          : true;
    } else {
      this.#eventTarget = eventTarget ?? new EventTarget();
      this.#isOnline = isOnline ?? true;
    }

    // Set up online/offline event listeners
    if (Connection.location?.hostname !== "localhost") {
      this.#setupOnlineOfflineListeners();
    }

    // Set up heartbeat and connection check if enabled
    this.#setupHeartbeat();
    this.#setupConnectionCheck();

    if (connect) {
      // Attempt to connect on next tick to allow for initialization
      Connection.setTimeout(() => {
        this.connect().catch((error) => {
          // Handle any errors from the initial connection attempt
          // This prevents unhandled promise rejections
          console.warn("Initial connection attempt failed:", error);
        });
      }, 0);
    }
  }

  protected setState(state: ConnectionState<Context>) {
    const previousState = this._state;
    this._state = state;
    this.call("update", state);
    switch (state.type) {
      case "connected":
        if (previousState.type !== "connected") {
          this.call("connected");
        }
        if (this.#messageBuffer.length > 0) {
          this.sendBufferedMessages();
        }
        break;
      case "disconnected":
        if (previousState.type !== "disconnected") {
          this.call("disconnected");
        }
        // If we were previously connected and should reconnect, schedule reconnection
        if (
          previousState.type === "connected" &&
          this.shouldAttemptConnection()
        ) {
          this.scheduleReconnect();
        }
        break;
    }
  }

  /**
   * Set up online/offline event listeners
   */
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
        this.initConnection();
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

  /**
   * Set up heartbeat if enabled
   */
  #setupHeartbeat() {
    if (this.#heartbeatIntervalMs > 0) {
      this.#heartbeatInterval = Connection.setInterval(() => {
        if (this.state.type === "connected") {
          this.sendHeartbeat();
        }
      }, this.#heartbeatIntervalMs);
    }
  }

  /**
   * Set up connection check if enabled
   */
  #setupConnectionCheck() {
    if (this.#messageReconnectTimeoutMs > 0) {
      this.#checkInterval = Connection.setInterval(() => {
        if (
          this.state.type === "connected" &&
          this.#messageReconnectTimeoutMs <
            Date.now() - this.#lastMessageReceived
        ) {
          this.#handleConnectionTimeout();
        }
      }, this.#messageReconnectTimeoutMs / 10);
    }
  }

  /**
   * Handle connection timeout
   */
  async #handleConnectionTimeout() {
    await this.closeConnection();
    const error = new Error("Connection timeout - no messages received");
    this.handleConnectionError(error);
  }

  /**
   * Schedule a reconnection attempt
   */
  protected scheduleReconnect() {
    if (this.#reconnectTimeout) {
      Connection.clearTimeout(this.#reconnectTimeout);
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

    this.#reconnectTimeout = Connection.setTimeout(() => {
      if (this.#reconnectAttempt >= this.#maxReconnectAttempts) {
        this.setState({
          type: "errored",
          context: { reconnectAttempt: this.#reconnectAttempt },
          error: new Error("Maximum reconnection attempts reached"),
        });
        return;
      }

      this.#reconnectAttempt++;
      this.initConnection();
    }, delay);
  }

  /**
   * Handle connection errors and schedule reconnection if needed
   */
  protected handleConnectionError(error: Error, reconnectAttempt?: number) {
    this.setState({
      type: "errored",
      context: { reconnectAttempt: reconnectAttempt ?? this.#reconnectAttempt },
      error,
    });
    this.scheduleReconnect();
  }

  /**
   * Send a buffered message if connected, otherwise buffer it
   */
  protected async sendOrBuffer(message: Message): Promise<void> {
    if (this.destroyed) {
      throw new Error("Connection is destroyed, create a new instance");
    }

    if (this.#disconnected) {
      return; // Don't send if manually disconnected
    }

    if (this.state.type === "connected") {
      try {
        await this.sendMessage(message);
      } catch (err) {
        const error =
          err instanceof Error
            ? err
            : new Error("Failed to send message", { cause: err });
        this.handleConnectionError(error);
      }
    } else {
      // Buffer message if not connected
      this.#messageBuffer.push(message);
    }
  }

  /**
   * Send all buffered messages
   */
  private async sendBufferedMessages() {
    while (this.#messageBuffer.length > 0) {
      const message = this.#messageBuffer.shift();
      if (message) {
        await this.sendOrBuffer(message);
      }
    }
  }

  /**
   * Check if the connection should attempt to connect
   */
  protected shouldAttemptConnection(): boolean {
    return this.#shouldConnect && !this.#disconnected && this.#isOnline;
  }

  /**
   * Update the last message received timestamp
   */
  protected updateLastMessageReceived(): void {
    this.#lastMessageReceived = Date.now();
  }

  /**
   * Send a heartbeat message (to be implemented by subclasses)
   */
  protected sendHeartbeat(): void {
    // Default implementation does nothing
    // Subclasses should override this to send actual heartbeat messages
  }

  /**
   * Allows subclasses to set up the underlying connection
   */
  protected abstract initConnection(): Promise<void>;

  /**
   * Send a message to the underlying connection (called when connected)
   */
  protected abstract sendMessage(message: Message): Promise<void>;

  /**
   * Send a message to the connection (public interface)
   */
  public async send(message: Message): Promise<void> {
    await this.sendOrBuffer(message);
  }

  /**
   * Connect to the underlying connection
   */
  public async connect(): Promise<void> {
    if (this.destroyed) {
      throw new Error("Connection is destroyed, create a new instance");
    }
    this.#shouldConnect = true;
    this.#disconnected = false;
    this.#reconnectAttempt = 0;
    this.#backoff.reset();
    if (this.state.type === "disconnected" && this.#isOnline) {
      await this.initConnection();
    }
    return await this.connected;
  }

  /**
   * Disconnect from the connection
   */
  public async disconnect(): Promise<void> {
    if (this.destroyed) {
      throw new Error("Connection is destroyed, create a new instance");
    }
    this.#shouldConnect = false;
    this.#disconnected = true;
    if (this.#reconnectTimeout) {
      clearTimeout(this.#reconnectTimeout);
    }
    await this.closeConnection();
  }

  /**
   * Disconnect the underlying connection (to be implemented by subclasses)
   */
  protected abstract closeConnection(): Promise<void>;

  /**
   * The current state of the connection
   */
  get state(): ConnectionState<Context> {
    return this._state;
  }

  /**
   * Get a reader for the connection (based on {@link FanOutReader})
   */
  getReader(): FanOutReader<RawReceivedMessage> {
    return this.fanOutWriter.getReader();
  }

  /**
   * A promise that resolves when the connection is connected
   */
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

  /**
   * Whether the connection is destroyed
   */
  public destroyed = false;

  /**
   * Destroy the connection
   */
  public async destroy(): Promise<void> {
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

    // Clear reconnection timeout
    if (this.#reconnectTimeout) {
      Connection.clearTimeout(this.#reconnectTimeout);
    }

    // Clear heartbeat and connection check intervals
    if (this.#heartbeatInterval) {
      Connection.clearInterval(this.#heartbeatInterval);
    }
    if (this.#checkInterval) {
      Connection.clearInterval(this.#checkInterval);
    }

    // Clear message buffer
    this.#messageBuffer = [];

    // Release the writer lock, then close the fan out writer
    this.writer.releaseLock();
    this.fanOutWriter.writable.close();

    await this.closeConnection();
  }
}
