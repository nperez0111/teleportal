import {
  AckMessage,
  DocMessage,
  Message,
  Observable,
  RawReceivedMessage,
  type VersionedUpdate,
} from "teleportal";
import {
  mergeContentEncryptedPayloads,
  type EncryptedUpdatePayload,
} from "teleportal/protocol/encryption";
import { createFanOutWriter, FanOutReader } from "teleportal/transports";
import type {
  ConnectionTransport,
  TokenOptions,
  TransportConnectContext,
} from "./transports/types";
import { ExponentialBackoff, TimerManager, type Timer } from "./utils";
import type { Connection, ConnectionDiagnostics, ConnectionEvents, ConnectionState } from "./types";

export type {
  Connection,
  ConnectionDiagnosticEvent,
  ConnectionDiagnostics,
  ConnectionEvents,
  ConnectionState,
  WorkerConnectionDiagnostics,
} from "./types";

export type ConnectionOptions = {
  url?: string;
  transports: ConnectionTransport[];
  token?: TokenOptions;
  connect?: boolean;
  maxReconnectAttempts?: number;
  initialReconnectDelay?: number;
  maxBackoffTime?: number;
  reconnectBackoffFactor?: number;
  heartbeatInterval?: number;
  messageReconnectTimeout?: number;
  minUptime?: number;
  reconnectDelayJitter?: number;
  maxBufferedMessages?: number;
  inFlightMessageTimeout?: number;
  batchIntervalMs?: number;
  maxBatchIntervalMs?: number;
  upgradeProbeInterval?: number;
  maxUpgradeProbeInterval?: number;
  timer?: Timer;
  eventTarget?: EventTarget;
  isOnline?: boolean;
};

export class TokenExpiredError extends Error {
  name = "TokenExpiredError" as const;
  constructor(message = "Token has expired") {
    super(message);
  }
}

export class TokenRefreshError extends Error {
  name = "TokenRefreshError" as const;
  constructor(cause?: unknown) {
    super(
      cause instanceof Error
        ? `Failed to refresh token: ${cause.message}`
        : "Failed to refresh token",
      { cause },
    );
  }
}

const DEFAULT_MAX_RECONNECT_ATTEMPTS = 10;
const DEFAULT_INITIAL_RECONNECT_DELAY = 100;
const DEFAULT_MAX_BACKOFF_TIME = 30_000;
const DEFAULT_MESSAGE_RECONNECT_TIMEOUT = 30_000;
const DEFAULT_MIN_UPTIME = 0;
const DEFAULT_RECONNECT_DELAY_JITTER = 0;
const DEFAULT_MAX_BUFFERED_MESSAGES = Number.POSITIVE_INFINITY;
const DEFAULT_RECONNECT_BACKOFF_FACTOR = 1.3;
const DEFAULT_IN_FLIGHT_MESSAGE_TIMEOUT = 30_000;
const DEFAULT_UPGRADE_PROBE_INTERVAL = 30_000;
const DEFAULT_MAX_UPGRADE_PROBE_INTERVAL = 300_000;
const MIN_BATCH_INTERVAL_MS = 10;

export class DirectConnection extends Observable<ConnectionEvents> implements Connection {
  static location: { hostname: string } | undefined = globalThis.location;

  readonly hosting = "direct" as const;

  #timerManager: TimerManager;
  #transports: ConnectionTransport[];
  #activeTransport: ConnectionTransport | null = null;
  #activeTransportIndex = -1;
  #url?: string;

  // Token state
  #token?: string;
  #tokenOptions?: TokenOptions;
  #tokenRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  // Connection intent
  #connectionIntent: "auto" | "manual" | "destroyed" = "auto";

  // Reconnection
  #reconnectAttempt = 0;
  #backoff: ExponentialBackoff;
  #maxReconnectAttempts: number;
  #reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  #minUptimeMs: number;
  #minUptimeTimer: ReturnType<typeof setTimeout> | null = null;
  #reconnectDelayJitter: number;
  #maxBufferedMessages: number;

  // Transport upgrade probe
  #upgradeProbeIntervalMs: number;
  #maxUpgradeProbeIntervalMs: number;
  #currentUpgradeProbeIntervalMs: number;
  #manualTransportOverride = false;
  #upgradeProbeTimer: ReturnType<typeof setTimeout> | null = null;
  #probeInProgress = false;

  // Online/offline
  #eventTarget: EventTarget;
  #isOnline = true;
  #onlineHandler: (() => void) | null = null;
  #offlineHandler: (() => void) | null = null;

  // Message buffering
  #messageBuffer: Message[] = [];

  // In-flight tracking
  #inFlightMessages = new Map<
    string,
    { message: Message; timer: ReturnType<typeof setTimeout> | null }
  >();
  #inFlightMessageTimeoutMs: number;

  // Update batching (AIMD)
  #batchIntervalMs: number;
  #maxBatchIntervalMs: number;
  #pendingUpdates = new Map<string, { updates: VersionedUpdate[]; message: DocMessage<any> }>();
  #batchFlushTimer: ReturnType<typeof setTimeout> | null = null;

  // Heartbeat & timeout
  #timeoutCheckTimer: ReturnType<typeof setTimeout> | null = null;
  #messageReceivedCount = 0;
  #heartbeatIntervalMs: number;
  #messageReconnectTimeoutMs: number;

  // Cached connected promise
  #connectedPromise: Promise<void> | null = null;
  #connectedPromiseUnsubscribe: (() => void) | null = null;

  // Fan-out writer
  #fanOutWriter = createFanOutWriter<RawReceivedMessage>();

  // State
  #state: ConnectionState = { type: "disconnected" };
  #connectionAttemptId = 0;

  constructor({
    url,
    transports,
    token,
    connect = true,
    maxReconnectAttempts = DEFAULT_MAX_RECONNECT_ATTEMPTS,
    initialReconnectDelay = DEFAULT_INITIAL_RECONNECT_DELAY,
    maxBackoffTime = DEFAULT_MAX_BACKOFF_TIME,
    reconnectBackoffFactor = DEFAULT_RECONNECT_BACKOFF_FACTOR,
    heartbeatInterval = 0,
    messageReconnectTimeout = DEFAULT_MESSAGE_RECONNECT_TIMEOUT,
    minUptime = DEFAULT_MIN_UPTIME,
    reconnectDelayJitter = DEFAULT_RECONNECT_DELAY_JITTER,
    maxBufferedMessages = DEFAULT_MAX_BUFFERED_MESSAGES,
    inFlightMessageTimeout = DEFAULT_IN_FLIGHT_MESSAGE_TIMEOUT,
    batchIntervalMs = 100,
    maxBatchIntervalMs = 5000,
    upgradeProbeInterval = DEFAULT_UPGRADE_PROBE_INTERVAL,
    maxUpgradeProbeInterval = DEFAULT_MAX_UPGRADE_PROBE_INTERVAL,
    timer,
    eventTarget,
    isOnline,
  }: ConnectionOptions) {
    super();

    this.#url = url;
    this.#transports = transports;
    this.#timerManager = new TimerManager(timer);
    this.#tokenOptions = token;
    this.#token = token?.token;

    const factor = reconnectBackoffFactor;
    const maxExponent =
      factor > 1
        ? Math.floor(Math.log(maxBackoffTime / initialReconnectDelay) / Math.log(factor))
        : 0;
    this.#backoff = new ExponentialBackoff(initialReconnectDelay, Math.max(0, maxExponent), factor);
    this.#maxReconnectAttempts = maxReconnectAttempts;
    this.#reconnectDelayJitter = Math.max(0, reconnectDelayJitter);
    this.#maxBufferedMessages =
      maxBufferedMessages <= 0 ? Number.POSITIVE_INFINITY : maxBufferedMessages;

    this.#heartbeatIntervalMs = heartbeatInterval;
    this.#messageReconnectTimeoutMs = messageReconnectTimeout;
    this.#minUptimeMs = minUptime;
    this.#inFlightMessageTimeoutMs = inFlightMessageTimeout;
    this.#batchIntervalMs = batchIntervalMs;
    this.#maxBatchIntervalMs = maxBatchIntervalMs;
    this.#upgradeProbeIntervalMs = upgradeProbeInterval;
    this.#maxUpgradeProbeIntervalMs = maxUpgradeProbeInterval;
    this.#currentUpgradeProbeIntervalMs = upgradeProbeInterval;

    // Online/offline
    if (globalThis.window === undefined) {
      this.#eventTarget = eventTarget ?? new EventTarget();
      this.#isOnline = isOnline ?? true;
    } else {
      this.#eventTarget = eventTarget ?? globalThis;
      // An explicit `isOnline` option always wins. Otherwise treat localhost
      // (dev) as always online and fall back to navigator.onLine elsewhere.
      if (isOnline !== undefined) {
        this.#isOnline = isOnline;
      } else if (DirectConnection.location?.hostname === "localhost") {
        this.#isOnline = true;
      } else {
        this.#isOnline = navigator.onLine ?? true;
      }
    }

    if (DirectConnection.location?.hostname !== "localhost") {
      this.#setupOnlineOfflineListeners();
    }

    this.#setupHeartbeat();
    this.#setupConnectionTimeoutCheck();

    if (connect) {
      this.#timerManager.setTimeout(() => {
        if (this.destroyed) return;
        this.connect().catch((error) => {
          console.warn("Initial connection attempt failed:", error);
        });
      }, 0);
    }

    this.on("ping", () => {
      this.#updateLastMessageReceived();
    });

    this.on("received-message", (message) => {
      if (message.type === "ack") {
        const messageId = message.payload.messageId;
        const entry = this.#inFlightMessages.get(messageId);
        if (entry) {
          if (entry.timer) this.#timerManager.clearTimeout(entry.timer);
          this.#inFlightMessages.delete(messageId);
          if (this.#inFlightMessages.size === 0) {
            this.call("messages-in-flight", false);
          }
          if (this.#batchIntervalMs > 0) {
            this.#batchIntervalMs = Math.max(MIN_BATCH_INTERVAL_MS, this.#batchIntervalMs - 10);
          }
        }
      } else {
        const ackMessage = new AckMessage({ type: "ack", messageId: message.id }, undefined);
        queueMicrotask(() => {
          if (this.destroyed) return;
          this.send(ackMessage).catch(() => {});
        });
      }
    });
  }

  // --- Public API ---

  get state(): ConnectionState {
    return this.#state;
  }

  get activeTransport(): string | null {
    return this.#activeTransport?.name ?? null;
  }

  get availableTransports(): string[] {
    return this.#transports.map((t) => t.name);
  }

  get destroyed(): boolean {
    return this.#connectionIntent === "destroyed";
  }

  get inFlightMessageCount(): number {
    return this.#inFlightMessages.size;
  }

  get diagnostics(): ConnectionDiagnostics {
    return {
      batchIntervalMs: this.#batchIntervalMs,
      maxBatchIntervalMs: this.#maxBatchIntervalMs,
      bufferedMessageCount: this.#messageBuffer.length,
      reconnectAttempt: this.#reconnectAttempt,
      maxReconnectAttempts: this.#maxReconnectAttempts,
      online: this.#isOnline,
    };
  }

  get connected(): Promise<void> {
    const currentState = this.#state;

    if (currentState.type === "connected") {
      this.#clearConnectedPromise();
      return Promise.resolve();
    }

    if (currentState.type === "errored") {
      this.#clearConnectedPromise();
      return Promise.reject(currentState.error);
    }

    if (this.#connectedPromise) {
      return this.#connectedPromise;
    }

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
        }
      });
    });

    return this.#connectedPromise;
  }

  getReader(): FanOutReader<RawReceivedMessage> {
    return this.#fanOutWriter.getReader();
  }

  /**
   * Fire-and-forget send for RPC stream messages (file chunks).
   * Skips in-flight tracking and event dispatch for throughput — chunk
   * payloads must never flow through the per-message event pipeline. Tooling
   * observes transfers via the file protocol's progress events instead
   * (`onFileTransferProgress` in teleportal/protocols/file).
   * Buffers if not connected so chunks are never silently dropped.
   */
  sendStream(message: Message): void {
    if (this.destroyed) return;
    if (this.#state.type === "connected" && this.#activeTransport) {
      this.#activeTransport.send(message).catch((err) => {
        this.#handleConnectionError(err);
        this.#bufferMessage(message);
      });
    } else {
      this.#bufferMessage(message);
    }
  }

  async send(message: Message): Promise<void> {
    if (this.destroyed) return;
    await this.#sendOrBuffer(message);
  }

  async connect(): Promise<void> {
    if (this.destroyed) {
      throw new Error("Connection is destroyed, create a new instance");
    }
    this.#connectionIntent = "auto";
    this.#manualTransportOverride = false;
    this.#reconnectAttempt = 0;
    this.#backoff.reset();
    this.#activeTransportIndex = -1;
    this.#currentUpgradeProbeIntervalMs = this.#upgradeProbeIntervalMs;
    this.#clearUpgradeProbeTimer();
    if ((this.#state.type === "disconnected" || this.#state.type === "errored") && this.#isOnline) {
      await this.#initConnection();
    }
    return await this.connected;
  }

  async switchTransport(name: string): Promise<void> {
    if (this.destroyed) {
      throw new Error("Connection is destroyed, create a new instance");
    }

    const targetIndex = this.#transports.findIndex((t) => t.name === name);
    if (targetIndex === -1) {
      throw new Error(
        `Unknown transport: "${name}". Available: ${this.#transports.map((t) => t.name).join(", ")}`,
      );
    }

    if (this.#activeTransportIndex === targetIndex && this.#state.type === "connected") {
      return;
    }

    this.#manualTransportOverride = true;
    this.#connectionIntent = "auto";
    this.#reconnectAttempt = 0;
    this.#backoff.reset();
    this.#activeTransportIndex = targetIndex;
    await this.#closeActiveTransport();
  }

  async disconnect(): Promise<void> {
    if (this.destroyed) return;
    this.#connectionIntent = "manual";
    this.#manualTransportOverride = false;
    if (this.#reconnectTimeout) {
      this.#timerManager.clearTimeout(this.#reconnectTimeout);
      this.#reconnectTimeout = null;
    }
    // Reset transport preference so next connect() starts from the top
    this.#activeTransportIndex = -1;
    await this.#closeActiveTransport();
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    super.destroy();
    this.#connectionIntent = "destroyed";

    if (this.#onlineHandler) {
      this.#eventTarget.removeEventListener("online", this.#onlineHandler);
    }
    if (this.#offlineHandler) {
      this.#eventTarget.removeEventListener("offline", this.#offlineHandler);
    }

    this.#clearMinUptimeTimer();
    this.#clearTokenRefreshTimer();
    this.#clearUpgradeProbeTimer();
    this.#timerManager.clearAll();
    this.#messageBuffer = [];

    if (this.#batchFlushTimer) {
      this.#timerManager.clearTimeout(this.#batchFlushTimer);
      this.#batchFlushTimer = null;
    }
    this.#pendingUpdates.clear();
    for (const { timer } of this.#inFlightMessages.values()) {
      if (timer) this.#timerManager.clearTimeout(timer);
    }
    this.#inFlightMessages.clear();
    this.#clearConnectedPromise();

    this.#fanOutWriter.close();

    await this.#closeActiveTransport();
  }

  // --- Connection lifecycle ---

  async #initConnection(): Promise<void> {
    if (this.destroyed || !this.#shouldAttemptConnection()) return;
    if (this.#state.type === "connecting" || this.#state.type === "connected") return;

    const currentAttemptId = ++this.#connectionAttemptId;

    // Determine which transports to try. If a transport previously succeeded,
    // start from that index. Otherwise start from the beginning.
    const startIndex = this.#activeTransportIndex >= 0 ? this.#activeTransportIndex : 0;
    const transportsToTry = [
      ...this.#transports.slice(startIndex),
      ...this.#transports.slice(0, startIndex),
    ];

    for (const transport of transportsToTry) {
      if (currentAttemptId !== this.#connectionAttemptId) return;
      if (this.destroyed) return;

      this.#setState({ type: "connecting", transport: transport.name });

      try {
        await this.#connectTransport(transport, currentAttemptId);
        if (currentAttemptId !== this.#connectionAttemptId) return;

        // Success
        this.#activeTransport = transport;
        this.#activeTransportIndex = this.#transports.indexOf(transport);
        this.#updateLastMessageReceived();
        this.#setState({ type: "connected", transport: transport.name });
        this.#scheduleTokenRefresh();
        return;
      } catch {
        if (currentAttemptId !== this.#connectionAttemptId) return;
        // Try next transport
      }
    }

    // All transports failed
    if (currentAttemptId === this.#connectionAttemptId) {
      this.#handleConnectionError(new Error("All transports failed to connect"));
    }
  }

  async #connectTransport(transport: ConnectionTransport, attemptId: number): Promise<void> {
    const timeout = transport.timeout ?? 10_000;

    const ctx: TransportConnectContext = {
      url: this.#url,
      token: this.#token,
      onMessage: (message) => {
        if (attemptId !== this.#connectionAttemptId) return;
        this.#updateLastMessageReceived();
        this.#fanOutWriter.send(message);
        this.call("received-message", message as Message);

        // Reactive token refresh: detect auth-message with permission denied
        if (
          message.type === "doc" &&
          (message.payload as any)?.type === "auth-message" &&
          (message.payload as any)?.permission === "denied" &&
          this.#tokenOptions?.onTokenExpired
        ) {
          this.#doTokenRefresh("reactive");
        }
      },
      onClose: (_error?) => {
        if (attemptId !== this.#connectionAttemptId) return;
        this.#activeTransport = null;
        this.#setState({ type: "disconnected" });
      },
      onPing: () => {
        if (attemptId !== this.#connectionAttemptId) return;
        this.call("ping");
      },
      timer: this.#timerManager.underlyingTimer,
    };

    const connectPromise = transport.connect(ctx);
    const timeoutPromise = new Promise<never>((_, reject) => {
      const timerId = this.#timerManager.setTimeout(() => {
        reject(new Error(`Transport "${transport.name}" connection timeout after ${timeout}ms`));
      }, timeout);
      connectPromise.then(
        () => this.#timerManager.clearTimeout(timerId),
        () => this.#timerManager.clearTimeout(timerId),
      );
    });

    await Promise.race([connectPromise, timeoutPromise]);
  }

  async #closeActiveTransport(): Promise<void> {
    this.#connectionAttemptId++;
    if (this.#activeTransport) {
      try {
        await this.#activeTransport.close();
      } catch {
        // ignore
      }
      this.#activeTransport = null;
    }
    if (this.#state.type !== "disconnected") {
      this.#setState({ type: "disconnected" });
    }
  }

  // --- State management ---

  #setState(state: ConnectionState) {
    const previousState = this.#state;
    if (previousState.type === "connected" && state.type !== "connected") {
      this.#clearMinUptimeTimer();
      this.#clearTokenRefreshTimer();
      this.#clearUpgradeProbeTimer();
    }

    this.#state = state;

    if (state.type === "connected" && this.#messageReconnectTimeoutMs > 0) {
      this.#scheduleTimeoutCheck();
    }

    this.call("update", state);

    if (
      previousState.type !== state.type &&
      (previousState.type === "connected" ||
        previousState.type === "errored" ||
        state.type === "connected" ||
        state.type === "errored")
    ) {
      this.#clearConnectedPromise();
    }

    switch (state.type) {
      case "connected": {
        if (previousState.type !== "connected") {
          this.call("connected");
        }
        if (this.#minUptimeMs > 0) {
          this.#clearMinUptimeTimer();
          this.#minUptimeTimer = this.#timerManager.setTimeout(() => {
            if (this.#state.type === "connected") {
              this.#reconnectAttempt = 0;
              this.#backoff.reset();
            }
          }, this.#minUptimeMs);
        } else {
          this.#reconnectAttempt = 0;
          this.#backoff.reset();
        }
        if (this.#messageBuffer.length > 0) {
          this.#sendBufferedMessages();
        }
        this.#scheduleUpgradeProbe();
        break;
      }
      case "disconnected": {
        // Flush pending batch to buffer BEFORE emitting disconnect event,
        // so batched messages precede any messages sent by disconnect listeners.
        if (this.#batchFlushTimer) {
          this.#timerManager.clearTimeout(this.#batchFlushTimer);
          this.#batchFlushTimer = null;
        }
        this.#flushBatch();

        if (previousState.type !== "disconnected") {
          this.call("disconnected");
        }

        const hadInFlight = this.#inFlightMessages.size > 0;
        for (const { timer } of this.#inFlightMessages.values()) {
          if (timer) this.#timerManager.clearTimeout(timer);
        }
        this.#inFlightMessages.clear();
        if (hadInFlight) {
          this.call("messages-in-flight", false);
        }
        if (previousState.type === "connected" && this.#shouldReconnect()) {
          this.#scheduleReconnect();
        }
        break;
      }
    }
  }

  // --- Reconnection ---

  #shouldAttemptConnection(): boolean {
    return this.#connectionIntent === "auto" && !this.destroyed && this.#isOnline;
  }

  #shouldReconnect(): boolean {
    return this.#shouldAttemptConnection();
  }

  #scheduleReconnect() {
    if (this.#reconnectTimeout) {
      this.#timerManager.clearTimeout(this.#reconnectTimeout);
      this.#reconnectTimeout = null;
    }
    if (!this.#shouldReconnect()) return;

    let delay = this.#backoff.next();
    if (this.#reconnectDelayJitter > 0) {
      delay += Math.random() * this.#reconnectDelayJitter;
    }
    delay = Math.max(0, Math.floor(delay));

    this.call("diagnostic", {
      type: "reconnect-scheduled",
      attempt: this.#reconnectAttempt + 1,
      maxAttempts: this.#maxReconnectAttempts,
      delayMs: delay,
    });

    this.#reconnectTimeout = this.#timerManager.setTimeout(() => {
      this.#reconnectTimeout = null;
      if (this.#reconnectAttempt >= this.#maxReconnectAttempts) {
        this.#setState({
          type: "errored",
          error: new Error("Maximum reconnection attempts reached"),
        });
        return;
      }
      this.#reconnectAttempt++;
      this.#initConnection();
    }, delay);
  }

  #handleConnectionError(error: Error) {
    this.#setState({ type: "errored", error });
    this.#scheduleReconnect();
  }

  // --- Message sending & buffering ---

  #isBatchableDocUpdate(message: Message): boolean {
    return (
      message.type === "doc" &&
      (message.payload as { type?: string })?.type === "update" &&
      message.document != null
    );
  }

  #scheduleBatchFlush(): void {
    if (this.#batchFlushTimer || this.#pendingUpdates.size === 0) return;
    const interval = this.#batchIntervalMs;
    if (interval <= 0) {
      this.#flushBatch();
      return;
    }
    this.#batchFlushTimer = this.#timerManager.setTimeout(() => {
      this.#batchFlushTimer = null;
      this.#flushBatch();
    }, interval);
  }

  #flushing = false;

  #flushBatch(): void {
    if (this.#pendingUpdates.size === 0) return;
    this.#flushing = true;
    for (const [, { updates, message }] of this.#pendingUpdates) {
      const batched =
        updates.length === 1
          ? message
          : new DocMessage(
              message.document,
              {
                type: "update",
                update: {
                  version: 2,
                  data: mergeContentEncryptedPayloads(
                    updates.map((u) => u.data as EncryptedUpdatePayload),
                  ),
                } as VersionedUpdate,
              },
              message.context,
              message.encrypted,
            );
      this.#sendOrBuffer(batched);
    }
    this.#pendingUpdates.clear();
    this.#flushing = false;
  }

  async #sendOrBuffer(message: Message): Promise<void> {
    if (this.destroyed) return;
    if (this.#connectionIntent === "manual") return;

    // Batch doc updates
    if (this.#batchIntervalMs > 0 && !this.#flushing && this.#isBatchableDocUpdate(message)) {
      const docMessage = message as DocMessage<any>;
      const doc = docMessage.document;
      const update = (docMessage.payload as { update: VersionedUpdate }).update;
      const existing = this.#pendingUpdates.get(doc);
      if (existing) {
        existing.updates.push(update);
      } else {
        this.#pendingUpdates.set(doc, { updates: [update], message: docMessage });
      }
      this.#scheduleBatchFlush();
      return;
    }

    if (this.#state.type === "connected" && this.#activeTransport) {
      if (message.type !== "ack" && message.type !== "awareness" && message.type !== "presence") {
        const wasEmpty = this.#inFlightMessages.size === 0;
        const timer =
          this.#inFlightMessageTimeoutMs > 0
            ? this.#timerManager.setTimeout(() => {
                if (this.#inFlightMessages.has(message.id)) {
                  this.#inFlightMessages.delete(message.id);
                  if (this.#inFlightMessages.size === 0) {
                    this.call("messages-in-flight", false);
                  }
                  this.#batchIntervalMs = Math.min(
                    this.#maxBatchIntervalMs,
                    Math.max(50, this.#batchIntervalMs * 2),
                  );
                }
              }, this.#inFlightMessageTimeoutMs)
            : null;
        this.#inFlightMessages.set(message.id, { message, timer });
        if (wasEmpty) {
          this.call("messages-in-flight", true);
        }
      }

      try {
        await this.#activeTransport.send(message);
        this.call("sent-message", message);
      } catch (err) {
        if (message.type !== "ack" && message.type !== "awareness" && message.type !== "presence") {
          const entry = this.#inFlightMessages.get(message.id);
          if (entry?.timer) this.#timerManager.clearTimeout(entry.timer);
          this.#inFlightMessages.delete(message.id);
          if (this.#inFlightMessages.size === 0) {
            this.call("messages-in-flight", false);
          }
        }
        if (message.type === "ack") return;
        await new Promise<void>((resolve) => {
          this.#timerManager.setTimeout(() => resolve(), 1);
        });
        const error =
          err instanceof Error ? err : new Error("Failed to send message", { cause: err });
        this.#handleConnectionError(error);
      }
    } else {
      this.#bufferMessage(message);
    }
  }

  async #sendBufferedMessages() {
    while (this.#messageBuffer.length > 0) {
      const message = this.#messageBuffer.shift();
      if (message) {
        await this.#sendOrBuffer(message);
      }
    }
  }

  #bufferMessage(message: Message): void {
    // Doc updates: merge with existing buffered update for the same document
    if (this.#isBatchableDocUpdate(message)) {
      const docMessage = message as DocMessage<any>;
      const update = (docMessage.payload as { update: VersionedUpdate }).update;
      const existingIndex = this.#messageBuffer.findIndex(
        (m) => this.#isBatchableDocUpdate(m) && m.document === docMessage.document,
      );
      if (existingIndex !== -1) {
        const existing = this.#messageBuffer[existingIndex] as DocMessage<any>;
        const existingUpdate = (existing.payload as { update: VersionedUpdate }).update;
        this.#messageBuffer[existingIndex] = new DocMessage(
          docMessage.document,
          {
            type: "update",
            update: {
              version: 2,
              data: mergeContentEncryptedPayloads(
                [existingUpdate, update].map((u) => u.data as EncryptedUpdatePayload),
              ),
            } as VersionedUpdate,
          },
          docMessage.context,
          docMessage.encrypted,
        );
        return;
      }
    }

    // Awareness: keep only the latest (replace any existing awareness message)
    if (message.type === "awareness") {
      const existingIndex = this.#messageBuffer.findIndex((m) => m.type === "awareness");
      if (existingIndex !== -1) {
        this.#messageBuffer[existingIndex] = message;
        return;
      }
    }

    // Everything else: append, respecting cap
    if (this.#messageBuffer.length < this.#maxBufferedMessages) {
      this.#messageBuffer.push(message);
    }
  }

  // --- Online/offline ---

  #setupOnlineOfflineListeners() {
    const handleOnline = () => {
      this.#isOnline = true;
      if (this.#connectionIntent === "auto" && this.#state.type === "disconnected") {
        // Coming back online is a fresh start: reset both backoff and the
        // attempt counter (#initConnection doesn't read the counter; only
        // #scheduleReconnect does, so leaving it incremented just shrinks the
        // future reconnect budget).
        this.#backoff.reset();
        this.#reconnectAttempt = 0;
        this.#initConnection();
      }
    };

    const handleOffline = () => {
      this.#isOnline = false;
      if (this.#reconnectTimeout) {
        this.#timerManager.clearTimeout(this.#reconnectTimeout);
        this.#reconnectTimeout = null;
      }
      this.#clearUpgradeProbeTimer();
    };

    this.#eventTarget.addEventListener("online", handleOnline);
    this.#eventTarget.addEventListener("offline", handleOffline);
    this.#onlineHandler = handleOnline;
    this.#offlineHandler = handleOffline;
  }

  // --- Heartbeat & timeout ---

  #setupHeartbeat() {
    if (this.#heartbeatIntervalMs > 0) {
      this.#timerManager.setInterval(() => {
        if (this.#state.type === "connected" && this.#activeTransport?.sendHeartbeat) {
          this.#activeTransport.sendHeartbeat();
        }
      }, this.#heartbeatIntervalMs);
    }
  }

  #setupConnectionTimeoutCheck() {
    // no-op: #scheduleTimeoutCheck is called from #setState on connected transition
  }

  #scheduleTimeoutCheck() {
    if (this.#timeoutCheckTimer) return;
    if (this.#state.type !== "connected") return;

    const countAtSchedule = this.#messageReceivedCount;
    this.#timeoutCheckTimer = this.#timerManager.setTimeout(() => {
      this.#timeoutCheckTimer = null;
      if (this.#state.type !== "connected") return;

      if (this.#messageReceivedCount !== countAtSchedule) {
        this.#scheduleTimeoutCheck();
      } else {
        this.#handleConnectionTimeout();
      }
    }, this.#messageReconnectTimeoutMs);
  }

  async #handleConnectionTimeout() {
    await this.#closeActiveTransport();
    this.#handleConnectionError(new Error("Connection timeout - no messages received"));
  }

  #updateLastMessageReceived(): void {
    this.#messageReceivedCount++;
  }

  // --- Token refresh ---

  #scheduleTokenRefresh() {
    if (!this.#tokenOptions?.onTokenExpired || !this.#token) return;

    const expiry = getTokenExpiry(this.#token);
    if (expiry === null) return;

    const refreshBefore = this.#tokenOptions.refreshBeforeExpiryMs ?? 60_000;
    const refreshAt = expiry - refreshBefore - Date.now();

    if (refreshAt <= 0) {
      this.#doTokenRefresh("scheduled");
      return;
    }

    this.#tokenRefreshTimer = this.#timerManager.setTimeout(() => {
      this.#tokenRefreshTimer = null;
      this.#doTokenRefresh("scheduled");
    }, refreshAt);
  }

  async #doTokenRefresh(reason: "scheduled" | "reactive") {
    if (!this.#tokenOptions?.onTokenExpired || !this.#token) return;

    try {
      const newToken = await this.#tokenOptions.onTokenExpired(this.#token);
      this.#token = newToken;
      this.#tokenOptions = { ...this.#tokenOptions, token: newToken };
      this.call("diagnostic", { type: "token-refresh", reason });

      // Reconnect with new token
      await this.#closeActiveTransport();
      if (this.#connectionIntent === "auto") {
        await this.#initConnection();
      }
    } catch (cause) {
      const error = new TokenRefreshError(cause);
      this.call("diagnostic", { type: "token-refresh-error", error: error.message });
      this.#setState({
        type: "errored",
        error,
      });
    }
  }

  #clearTokenRefreshTimer() {
    if (this.#tokenRefreshTimer) {
      this.#timerManager.clearTimeout(this.#tokenRefreshTimer);
      this.#tokenRefreshTimer = null;
    }
  }

  // --- Transport upgrade probe ---

  #scheduleUpgradeProbe(): void {
    this.#clearUpgradeProbeTimer();

    if (
      this.#manualTransportOverride ||
      this.#upgradeProbeIntervalMs <= 0 ||
      this.#activeTransportIndex <= 0 ||
      this.#transports.length < 2 ||
      this.#connectionIntent !== "auto"
    ) {
      return;
    }

    const preferredTransport = this.#transports[0];
    if (!preferredTransport?.probe) return;

    this.#upgradeProbeTimer = this.#timerManager.setTimeout(() => {
      this.#upgradeProbeTimer = null;
      this.#performUpgradeProbe();
    }, this.#currentUpgradeProbeIntervalMs);
  }

  async #performUpgradeProbe(): Promise<void> {
    if (
      this.#probeInProgress ||
      this.destroyed ||
      this.#state.type !== "connected" ||
      this.#activeTransportIndex <= 0
    ) {
      return;
    }

    this.#probeInProgress = true;
    try {
      const preferredTransport = this.#transports[0];
      if (!preferredTransport?.probe) return;

      const succeeded = await preferredTransport.probe({
        url: this.#url,
        token: this.#token,
        timer: this.#timerManager.underlyingTimer,
      });

      if (this.destroyed || this.#state.type !== "connected" || this.#activeTransportIndex <= 0) {
        return;
      }

      if (succeeded) {
        this.call("diagnostic", { type: "upgrade-probe", result: "upgraded" });
        this.#currentUpgradeProbeIntervalMs = this.#upgradeProbeIntervalMs;
        this.#activeTransportIndex = 0;
        await this.#closeActiveTransport();
      } else {
        this.call("diagnostic", { type: "upgrade-probe", result: "unavailable" });
        this.#currentUpgradeProbeIntervalMs = Math.min(
          this.#currentUpgradeProbeIntervalMs * 2,
          this.#maxUpgradeProbeIntervalMs,
        );
        this.#scheduleUpgradeProbe();
      }
    } catch {
      this.#currentUpgradeProbeIntervalMs = Math.min(
        this.#currentUpgradeProbeIntervalMs * 2,
        this.#maxUpgradeProbeIntervalMs,
      );
      this.#scheduleUpgradeProbe();
    } finally {
      this.#probeInProgress = false;
    }
  }

  #clearUpgradeProbeTimer(): void {
    if (this.#upgradeProbeTimer) {
      this.#timerManager.clearTimeout(this.#upgradeProbeTimer);
      this.#upgradeProbeTimer = null;
    }
  }

  // --- Utility ---

  #clearMinUptimeTimer(): void {
    if (this.#minUptimeTimer) {
      this.#timerManager.clearTimeout(this.#minUptimeTimer);
      this.#minUptimeTimer = null;
    }
  }

  #clearConnectedPromise() {
    if (this.#connectedPromiseUnsubscribe) {
      this.#connectedPromiseUnsubscribe();
      this.#connectedPromiseUnsubscribe = null;
    }
    this.#connectedPromise = null;
  }
}

function getTokenExpiry(token: string): number | null {
  try {
    const [, payload] = token.split(".");
    if (!payload) return null;
    // JWT payloads are base64url-encoded (using - and _), which atob does not
    // accept; convert to standard base64 before decoding.
    const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof decoded.exp === "number" ? decoded.exp * 1000 : null;
  } catch {
    return null;
  }
}
