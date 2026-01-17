import {
  AckMessage,
  Message,
  Observable,
  RawReceivedMessage,
} from "teleportal";
import { createFanOutWriter, FanOutReader } from "teleportal/transports";
import { ExponentialBackoff, TimerManager, type Timer } from "./utils";

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
  /**
   * Timer implementation for dependency injection (testing)
   *
   * @default defaultTimer
   */
  timer?: Timer;
};

const DEFAULT_MAX_RECONNECT_ATTEMPTS = 10;
const DEFAULT_INITIAL_RECONNECT_DELAY = 100;
const DEFAULT_MAX_BACKOFF_TIME = 30_000;
const DEFAULT_MESSAGE_RECONNECT_TIMEOUT = 30_000;

export abstract class Connection<
  Context extends ConnectionContext,
> extends Observable<{
  update: (state: ConnectionState<Context>) => void;
  connected: () => void;
  disconnected: () => void;
  ping: () => void;
  "messages-in-flight": (hasInFlight: boolean) => void;
  "sent-message": (message: Message) => void;
  "received-message": (message: Message) => void;
}> {
  static location: { hostname: string } | undefined = globalThis.location;

  // Timer management
  protected timerManager: TimerManager;

  // Connection intent state - single source of truth
  // "auto" = should auto-connect/reconnect, "manual" = user explicitly disconnected, "destroyed" = destroyed
  #connectionIntent: "auto" | "manual" | "destroyed" = "auto";

  // Reconnection state
  #reconnectAttempt = 0;
  #backoff: ExponentialBackoff;
  #maxReconnectAttempts: number;
  #reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

  // Online/offline state
  #eventTarget: EventTarget;
  #isOnline: boolean = true;
  #onlineHandler: (() => void) | null = null;
  #offlineHandler: (() => void) | null = null;

  // Message buffering
  #messageBuffer: Message[] = [];

  // In-flight message tracking (messages sent but not yet acked, excluding awareness)
  #inFlightMessages = new Map<string, Message>();

  // Heartbeat and connection check state
  #heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  #timeoutCheckTimer: ReturnType<typeof setTimeout> | null = null;
  #lastMessageReceived = 0;
  #heartbeatIntervalMs: number;
  #messageReconnectTimeoutMs: number;

  // Cached promise for connected getter
  #connectedPromise: Promise<void> | null = null;
  #connectedPromiseUnsubscribe: (() => void) | null = null;

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
    timer,
  }: ConnectionOptions = {}) {
    super();

    // Initialize timer manager
    this.timerManager = new TimerManager(timer);

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
    if (globalThis.window === undefined) {
      this.#eventTarget = eventTarget ?? new EventTarget();
      this.#isOnline = isOnline ?? true;
    } else {
      this.#eventTarget = eventTarget ?? globalThis;
      this.#isOnline =
        (isOnline ?? Connection.location?.hostname !== "localhost")
          ? (navigator.onLine ?? true)
          : true;
    }

    // Set up online/offline event listeners
    if (Connection.location?.hostname !== "localhost") {
      this.#setupOnlineOfflineListeners();
    }

    // Set up heartbeat if enabled
    this.#setupHeartbeat();

    // Set up event-driven connection timeout check
    this.#setupConnectionTimeoutCheck();

    if (connect) {
      // Attempt to connect on next tick to allow for initialization
      this.timerManager.setTimeout(() => {
        // Don't attempt to connect if the connection has been destroyed
        if (this.destroyed) {
          return;
        }
        this.connect().catch((error) => {
          // Handle any errors from the initial connection attempt
          // This prevents unhandled promise rejections
          console.warn("Initial connection attempt failed:", error);
        });
      }, 0);
    }
    this.on("ping", () => {
      this.updateLastMessageReceived();
    });

    // Listen for ack messages to remove them from in-flight tracking
    this.on("received-message", (message) => {
      if (message.type === "ack") {
        const messageId = message.payload.messageId;
        if (this.#inFlightMessages.has(messageId)) {
          this.#inFlightMessages.delete(messageId);
          // Emit event with current in-flight status
          this.call("messages-in-flight", this.#inFlightMessages.size > 0);
        }
      } else {
        // Send ACK for all non-ACK messages received from the server
        // (The server will drop these, but it's useful to have them anyway)
        const ackMessage = new AckMessage(
          {
            type: "ack",
            messageId: message.id,
          },
          undefined,
        );
        // Send ACK asynchronously without blocking
        queueMicrotask(() => {
          // Skip if connection was destroyed before microtask ran
          if (this.destroyed) return;
          this.send(ackMessage).catch(() => {
            // Ignore errors when sending ACK (connection might be closed)
          });
        });
      }
    });
  }

  private getPayloadType(message: Message): string | undefined {
    if (message.type !== "doc") return undefined;
    const payload = message.payload as { type?: string } | undefined;
    return payload?.type;
  }

  protected setState(state: ConnectionState<Context>) {
    const previousState = this._state;
    this._state = state;
    this.call("update", state);

    // Invalidate cached connected promise only when transitioning away from connected/errored
    // or when already in connected/errored state (to allow fresh promises)
    // Don't clear when transitioning TO connecting/connected (that would break the promise)
    if (
      previousState.type !== state.type &&
      (previousState.type === "connected" ||
        previousState.type === "errored" ||
        state.type === "connected" ||
        state.type === "errored") && // Only clear if we're already connected/errored (to allow fresh promises)
      // or if we're transitioning away from connected/errored
      (previousState.type === "connected" ||
        previousState.type === "errored" ||
        (state.type === "connected" && previousState.type !== "connecting") ||
        (state.type === "errored" && previousState.type !== "connecting"))
    ) {
      this.#clearConnectedPromise();
    }

    switch (state.type) {
      case "connected": {
        if (previousState.type !== "connected") {
          this.call("connected");
        }
        if (this.#messageBuffer.length > 0) {
          this.sendBufferedMessages();
        }
        break;
      }
      case "disconnected": {
        if (previousState.type !== "disconnected") {
          this.call("disconnected");
        }
        // Clear in-flight messages when disconnected (they'll need to be re-sent)
        const hadInFlightMessages = this.#inFlightMessages.size > 0;
        this.#inFlightMessages.clear();
        if (hadInFlightMessages) {
          this.call("messages-in-flight", false);
        }
        // If we were previously connected and should reconnect, schedule reconnection
        if (previousState.type === "connected" && this.shouldReconnect()) {
          this.scheduleReconnect();
        }
        break;
      }
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
        this.#connectionIntent === "auto" &&
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
        this.timerManager.clearTimeout(this.#reconnectTimeout);
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
      this.#heartbeatInterval = this.timerManager.setInterval(() => {
        if (this.state.type === "connected") {
          this.sendHeartbeat();
        }
      }, this.#heartbeatIntervalMs);
    }
  }

  /**
   * Set up event-driven connection timeout check
   * Uses a timeout that reschedules itself when messages are received
   */
  #setupConnectionTimeoutCheck() {
    if (this.#messageReconnectTimeoutMs > 0) {
      this.#scheduleTimeoutCheck();
    }
  }

  /**
   * Schedule a timeout check for connection health
   */
  #scheduleTimeoutCheck() {
    // Clear existing timeout check
    if (this.#timeoutCheckTimer) {
      this.timerManager.clearTimeout(this.#timeoutCheckTimer);
      this.#timeoutCheckTimer = null;
    }

    // Only schedule if connected
    if (this.state.type !== "connected") {
      return;
    }

    const timeSinceLastMessage = Date.now() - this.#lastMessageReceived;
    const timeUntilTimeout =
      this.#messageReconnectTimeoutMs - timeSinceLastMessage;

    if (timeUntilTimeout <= 0) {
      // Already timed out
      this.#handleConnectionTimeout();
      return;
    }

    // Schedule check for when timeout would occur
    this.#timeoutCheckTimer = this.timerManager.setTimeout(() => {
      this.#timeoutCheckTimer = null;
      if (
        this.state.type === "connected" &&
        this.#messageReconnectTimeoutMs < Date.now() - this.#lastMessageReceived
      ) {
        this.#handleConnectionTimeout();
      }
    }, timeUntilTimeout);
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
   * Check if the connection should attempt to connect (for initial connections or reconnections)
   */
  protected shouldAttemptConnection(): boolean {
    return (
      this.#connectionIntent === "auto" && !this.destroyed && this.#isOnline
    );
  }

  /**
   * Check if the connection should attempt to reconnect (specifically for reconnection logic)
   */
  protected shouldReconnect(): boolean {
    return this.shouldAttemptConnection();
  }

  /**
   * Schedule a reconnection attempt
   */
  protected scheduleReconnect() {
    if (this.#reconnectTimeout) {
      this.timerManager.clearTimeout(this.#reconnectTimeout);
      this.#reconnectTimeout = null;
    }

    if (!this.shouldReconnect()) {
      return;
    }

    // Use exponential backoff for delay calculation
    const delay = this.#backoff.next();

    this.#reconnectTimeout = this.timerManager.setTimeout(() => {
      this.#reconnectTimeout = null;
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
  protected handleConnectionError(error: Error) {
    this.setState({
      type: "errored",
      context: { reconnectAttempt: this.#reconnectAttempt },
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

    if (this.#connectionIntent === "manual") {
      return; // Don't send if manually disconnected
    }

    if (this.state.type === "connected") {
      // Track non-ack, non-awareness messages as in-flight
      if (message.type !== "ack" && message.type !== "awareness") {
        const wasEmpty = this.#inFlightMessages.size === 0;
        this.#inFlightMessages.set(message.id, message);
        // Emit event when messages become in-flight
        if (wasEmpty) {
          this.call("messages-in-flight", true);
        }
      }

      this.sendMessage(message).catch(async (err) => {
        // Remove from in-flight if send fails
        if (message.type !== "ack" && message.type !== "awareness") {
          this.#inFlightMessages.delete(message.id);
          // Emit event with current in-flight status
          this.call("messages-in-flight", this.#inFlightMessages.size > 0);
        }

        // Don't trigger reconnection for ACK messages - they're fire-and-forget
        // and shouldn't cause connection state changes
        if (message.type === "ack") {
          return;
        }

        // Workaround for Bun promise rejection handling bug
        // See: https://github.com/oven-sh/bun/issues/XXX
        await new Promise<void>((resolve) => {
          this.timerManager.setTimeout(() => resolve(), 1);
        });
        const error =
          err instanceof Error
            ? err
            : new Error("Failed to send message", { cause: err });
        this.handleConnectionError(error);
      });
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
   * Update the last message received timestamp
   */
  protected updateLastMessageReceived(): void {
    this.#lastMessageReceived = Date.now();
    // Reschedule timeout check when message received
    if (this.#messageReconnectTimeoutMs > 0) {
      this.#scheduleTimeoutCheck();
    }
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
    this.#connectionIntent = "auto";
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
    this.#connectionIntent = "manual";
    if (this.#reconnectTimeout) {
      this.timerManager.clearTimeout(this.#reconnectTimeout);
      this.#reconnectTimeout = null;
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
   * Get the number of in-flight messages (excluding awareness messages)
   */
  get inFlightMessageCount(): number {
    return this.#inFlightMessages.size;
  }

  /**
   * A promise that resolves when the connection is connected
   *
   * This promise is automatically invalidated when the connection state changes
   * to disconnected or errored, ensuring fresh promises for new connection attempts.
   */
  get connected(): Promise<void> {
    const currentState = this.state;

    // If already connected, return resolved promise
    if (currentState.type === "connected") {
      // Clear any cached promise and unsubscribe
      this.#clearConnectedPromise();
      return Promise.resolve();
    }

    // If errored, return rejected promise and clear cache
    if (currentState.type === "errored") {
      this.#clearConnectedPromise();
      return Promise.reject(currentState.error);
    }

    // If we have a cached promise for disconnected/connecting state, reuse it
    // The promise will be invalidated automatically when state changes
    if (this.#connectedPromise) {
      return this.#connectedPromise;
    }

    // Create new promise and cache it
    this.#connectedPromise = new Promise((resolve, reject) => {
      let handled = false;
      this.#connectedPromiseUnsubscribe = this.on("update", (state) => {
        if (!handled) {
          if (state.type === "connected") {
            handled = true;
            this.#clearConnectedPromise();
            resolve();
          } else if (state.type === "errored") {
            handled = true;
            this.#clearConnectedPromise();
            reject(state.error);
          }
          // Note: We don't handle disconnected/connecting here because
          // the promise should remain pending until connected or errored
        }
      });
    });

    return this.#connectedPromise;
  }

  /**
   * Clear the cached connected promise and unsubscribe
   */
  #clearConnectedPromise() {
    if (this.#connectedPromiseUnsubscribe) {
      this.#connectedPromiseUnsubscribe();
      this.#connectedPromiseUnsubscribe = null;
    }
    this.#connectedPromise = null;
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
    this.#connectionIntent = "destroyed";

    // Clean up online/offline listeners
    if (this.#onlineHandler) {
      this.#eventTarget.removeEventListener("online", this.#onlineHandler);
    }
    if (this.#offlineHandler) {
      this.#eventTarget.removeEventListener("offline", this.#offlineHandler);
    }

    // Clear all timers using timer manager
    this.timerManager.clearAll();

    // Clear message buffer
    this.#messageBuffer = [];

    // Clear in-flight messages
    this.#inFlightMessages.clear();

    // Clear connected promise
    this.#clearConnectedPromise();

    // Release the writer lock, then close the fan out writer
    this.writer.releaseLock();
    this.fanOutWriter.writable.close();

    await this.closeConnection();
  }
}
