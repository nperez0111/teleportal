import { decodeMessage } from "teleportal/protocol";
import { PresenceMessage, type BinaryMessage, type Message } from "teleportal";
import type { ConnectionTransport } from "../transports/types";
import { DirectConnection } from "../connection";
import { RpcClient } from "../rpc-client";
import {
  getFileClientHandlers,
  type FileClientHandlerInstance,
} from "../../protocols/file/transfer";
import type { DownstreamMessage, SerializedConnectionOptions, UpstreamMessage } from "./protocol";

const DEFAULT_GRACE_PERIOD_MS = 5_000;
const DEFAULT_STALE_PORT_CHECK_MS = 60_000;
// The sweep is a last-resort fallback behind the port `close` event and the
// tab's pagehide destroy. Browsers throttle timers in hidden tabs to as little
// as one wake per minute (Chrome's intensive throttling), so the threshold
// must sit well above that or healthy backgrounded tabs get reaped.
const DEFAULT_STALE_PORT_THRESHOLD_MS = 300_000;

/**
 * Default pooling key: URL *and* token. Two tabs share an underlying connection
 * only when both match, so connections authenticated with different tokens are
 * never reused. This keeps multi-author scenarios (where identity/attribution is
 * derived from the token) correctly isolated without the manager having to
 * understand the token format. The token is treated as an opaque string.
 */
const defaultConnectionKey = (options: SerializedConnectionOptions): string =>
  `${options.url ?? "default"}::${options.token ?? ""}`;

export interface ConnectionWorkerManagerOptions {
  gracePeriodMs?: number;
  /**
   * How often (ms) the manager checks for ports whose tab-side heartbeat has
   * stopped. This is a fallback for browsers without the MessagePort `close`
   * event; dead tabs are normally detected via `close`. Defaults to 60 000.
   */
  stalePortCheckMs?: number;
  /**
   * A port that has heartbeated before is considered stale when its last
   * heartbeat is older than this (ms). Must sit well above the browser's
   * hidden-tab timer throttling (Chrome wakes throttled timers at most once
   * per minute), or healthy backgrounded tabs get reaped. Defaults to 300 000.
   */
  stalePortThresholdMs?: number;
  /**
   * Decides which incoming connections share an underlying transport: two tabs
   * whose options produce the same key reuse one connection, different keys get
   * separate connections.
   *
   * Defaults to keying on URL + token (see {@link defaultConnectionKey}), which
   * isolates different authors. Override to widen sharing — e.g. return a stable
   * per-user id so the same author shares one connection across token refreshes —
   * without the manager needing to parse the token itself.
   */
  getConnectionKey?: (options: SerializedConnectionOptions) => string;
}

export class ConnectionWorkerManager {
  #connections = new Map<string, ManagedConnection>();
  #transportFactory: (desc: SerializedConnectionOptions) => ConnectionTransport[];
  #gracePeriodMs: number;
  #getConnectionKey: (options: SerializedConnectionOptions) => string;
  #stalePortTimer: ReturnType<typeof setInterval> | null = null;
  #stalePortThresholdMs: number;

  constructor(
    transportFactory: (desc: SerializedConnectionOptions) => ConnectionTransport[],
    options?: ConnectionWorkerManagerOptions,
  ) {
    this.#transportFactory = transportFactory;
    this.#gracePeriodMs = options?.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS;
    this.#getConnectionKey = options?.getConnectionKey ?? defaultConnectionKey;
    this.#stalePortThresholdMs = options?.stalePortThresholdMs ?? DEFAULT_STALE_PORT_THRESHOLD_MS;
    this.#startStalePortSweep(options?.stalePortCheckMs ?? DEFAULT_STALE_PORT_CHECK_MS);
  }

  addPort(port: MessagePort): void {
    const portState = new PortState(port);

    port.onmessage = (event: MessageEvent<UpstreamMessage>) => {
      this.#handleUpstream(event.data, portState);
    };

    // Primary dead-tab signal: the `close` event fires when the tab-side port
    // is disentangled (tab refreshed, closed, or crashed) — the cases where no
    // `destroy` message ever arrives. Older browsers without it fall back to
    // the pagehide destroy and the stale-port sweep.
    port.addEventListener?.("close", () => {
      this.#releasePort(portState);
    });

    port.start?.();
  }

  #handleUpstream(msg: UpstreamMessage, portState: PortState): void {
    switch (msg.type) {
      case "init":
        this.#handleInit(msg.options, msg.tabId, portState);
        break;

      case "send": {
        const conn = portState.managedConnection;
        if (!conn) return;
        const decoded = decodeMessage(msg.encoded as BinaryMessage);
        if (decoded.type === "presence") {
          const payload = decoded.payload;
          if (payload.type === "presence-announce") {
            portState.trackAnnounce(decoded.document, payload.awarenessId);
          } else if (payload.type === "presence-unannounce") {
            portState.trackUnannounce(decoded.document, payload.awarenessId);
          }
        }
        conn.connection.send(decoded).catch(() => {});
        // Sibling tabs share this connection, and the server excludes the
        // whole connection when broadcasting a client's own messages — so
        // tab-to-tab content must be relayed here. Only content messages:
        // sync/awareness-request handshakes are server-directed, and a
        // sibling receiving one would answer it and cross-talk the protocol.
        if (
          (decoded.type === "doc" && decoded.payload.type === "update") ||
          (decoded.type === "awareness" && decoded.payload.type === "awareness-update")
        ) {
          conn.relayToSiblings(portState, msg.encoded as Uint8Array);
        }
        break;
      }

      case "send-stream": {
        const conn = portState.managedConnection;
        if (!conn) return;
        const decoded = decodeMessage(msg.encoded as BinaryMessage);
        conn.connection.sendStream(decoded);
        break;
      }

      case "connect": {
        const conn = portState.managedConnection;
        if (!conn) {
          portState.respond(msg.requestId, "No connection");
          return;
        }
        conn.connection
          .connect()
          .then(() => portState.respond(msg.requestId))
          .catch((e: Error) => portState.respond(msg.requestId, e.message));
        break;
      }

      case "disconnect": {
        const conn = portState.managedConnection;
        if (!conn) {
          portState.respond(msg.requestId, "No connection");
          return;
        }
        conn.connection
          .disconnect()
          .then(() => portState.respond(msg.requestId))
          .catch((e: Error) => portState.respond(msg.requestId, e.message));
        break;
      }

      case "switch-transport": {
        const conn = portState.managedConnection;
        if (!conn) {
          portState.respond(msg.requestId, "No connection");
          return;
        }
        conn.connection
          .switchTransport(msg.transport)
          .then(() => portState.respond(msg.requestId))
          .catch((e: Error) => portState.respond(msg.requestId, e.message));
        break;
      }

      case "flush-sync": {
        const conn = portState.managedConnection;
        if (!conn) {
          portState.post({ type: "flush-sync-result", count: 0 });
          return;
        }
        const count = conn.connection.flushSync();
        portState.post({ type: "flush-sync-result", count });
        break;
      }

      case "flush-async": {
        const conn = portState.managedConnection;
        if (!conn) {
          portState.respond(msg.requestId, "No connection");
          return;
        }
        conn.connection
          .flushAsync()
          .then(() => portState.respond(msg.requestId))
          .catch((e: Error) => portState.respond(msg.requestId, e.message));
        break;
      }

      case "destroy":
        this.#handleDestroy(portState);
        break;

      case "network-status": {
        const conn = portState.managedConnection;
        if (!conn) return;
        portState.online = msg.online;
        conn.reconcileOnlineState();
        break;
      }

      case "heartbeat":
        portState.lastHeartbeat = Date.now();
        portState.post({ type: "heartbeat-ack" });
        break;

      case "get-diagnostics": {
        const conn = portState.managedConnection;
        if (!conn) return;
        portState.post({ type: "diagnostics", diagnostics: conn.buildDiagnostics() });
        break;
      }

      case "file-upload": {
        const conn = portState.managedConnection;
        if (!conn) {
          portState.post({
            type: "file-upload-error",
            requestId: msg.requestId,
            error: "No connection",
          });
          return;
        }
        conn
          .uploadFile(msg.file, msg.document, msg.fileId, msg.encryptionKey)
          .then((fileId) =>
            portState.post({ type: "file-upload-result", requestId: msg.requestId, fileId }),
          )
          .catch((e: Error) =>
            portState.post({
              type: "file-upload-error",
              requestId: msg.requestId,
              error: e.message,
            }),
          );
        break;
      }

      case "file-download": {
        const conn = portState.managedConnection;
        if (!conn) {
          portState.post({
            type: "file-download-error",
            requestId: msg.requestId,
            error: "No connection",
          });
          return;
        }
        conn
          .downloadFile(msg.fileId, msg.document, msg.encryptionKey, msg.timeout)
          .then((file) =>
            portState.post({ type: "file-download-result", requestId: msg.requestId, file }),
          )
          .catch((e: Error) =>
            portState.post({
              type: "file-download-error",
              requestId: msg.requestId,
              error: e.message,
            }),
          );
        break;
      }
    }
  }

  #handleInit(options: SerializedConnectionOptions, tabId: string, portState: PortState): void {
    const key = this.#getConnectionKey(options);
    portState.tabId = tabId;

    let managed = this.#connections.get(key);
    if (managed) {
      managed.cancelGracePeriod();
    } else {
      const transports = this.#transportFactory(options);
      const networkTarget = new EventTarget();

      const connection = new DirectConnection({
        url: options.url,
        transports,
        token: options.token ? { token: options.token } : undefined,
        connect: options.connect ?? true,
        maxReconnectAttempts: options.maxReconnectAttempts,
        initialReconnectDelay: options.initialReconnectDelay,
        maxBackoffTime: options.maxBackoffTime,
        reconnectBackoffFactor: options.reconnectBackoffFactor,
        heartbeatInterval: options.heartbeatInterval,
        messageReconnectTimeout: options.messageReconnectTimeout,
        minUptime: options.minUptime,
        reconnectDelayJitter: options.reconnectDelayJitter,
        maxBufferedMessages: options.maxBufferedMessages,
        inFlightMessageTimeout: options.inFlightMessageTimeout,
        batchIntervalMs: options.batchIntervalMs,
        maxBatchIntervalMs: options.maxBatchIntervalMs,
        eventTarget: networkTarget,
        isOnline: true,
      });

      managed = new ManagedConnection(key, connection, networkTarget, this.#gracePeriodMs);
      this.#connections.set(key, managed);
    }

    managed.addPort(portState);
    portState.managedConnection = managed;

    portState.post({ type: "ready", state: managed.connection.state });
    portState.postProperties(managed.connection);
  }

  #handleDestroy(portState: PortState): void {
    this.#releasePort(portState);
    portState.port.close();
  }

  /**
   * Release a port's connection resources: retract any presence it never
   * unannounced, detach it, and start the grace period if the connection has
   * no ports left. Idempotent — a port can be released by an explicit
   * `destroy` message, the port `close` event, or the stale sweep, in any
   * combination.
   */
  #releasePort(portState: PortState): void {
    if (portState.released) return;
    portState.released = true;
    const conn = portState.managedConnection;
    if (!conn) return;
    this.#sendPendingUnannounces(portState, conn);
    conn.removePort(portState);
    if (conn.portCount === 0) {
      conn.scheduleGracePeriod(this.#gracePeriodMs, () => {
        conn.destroy();
        this.#connections.delete(conn.key);
      });
    }
  }

  #sendPendingUnannounces(portState: PortState, conn: ManagedConnection): void {
    for (const [document, ids] of portState.announcedPresence) {
      for (const awarenessId of ids) {
        const msg = new PresenceMessage(document, {
          type: "presence-unannounce",
          awarenessId,
        });
        conn.connection.send(msg).catch(() => {});
      }
    }
    portState.announcedPresence.clear();
  }

  #startStalePortSweep(intervalMs: number): void {
    this.#stalePortTimer = setInterval(() => this.#sweepStalePorts(), intervalMs);
    (this.#stalePortTimer as { unref?: () => void }).unref?.();
  }

  #sweepStalePorts(): void {
    const now = Date.now();
    for (const managed of this.#connections.values()) {
      for (const port of managed.getStalePorts(now, this.#stalePortThresholdMs)) {
        this.#releasePort(port);
        port.port.close();
      }
    }
  }

  getConnection(key: string): DirectConnection | undefined {
    return this.#connections.get(key)?.connection;
  }

  get connectionCount(): number {
    return this.#connections.size;
  }
}

class PortState {
  port: MessagePort;
  tabId = "";
  online = true;
  managedConnection: ManagedConnection | null = null;
  /** Awareness IDs this port has announced, keyed by document name. */
  announcedPresence = new Map<string, Set<number>>();
  /**
   * When the tab last heartbeated, or null if it never has. Only ports that
   * heartbeat are eligible for the stale sweep — a silent-by-design port
   * (custom WorkerConnection without startHeartbeat) is never reaped.
   */
  lastHeartbeat: number | null = null;
  /** Set once the port's connection resources have been released. */
  released = false;

  constructor(port: MessagePort) {
    this.port = port;
  }

  trackAnnounce(document: string, awarenessId: number): void {
    let ids = this.announcedPresence.get(document);
    if (!ids) {
      ids = new Set();
      this.announcedPresence.set(document, ids);
    }
    ids.add(awarenessId);
  }

  trackUnannounce(document: string, awarenessId: number): void {
    const ids = this.announcedPresence.get(document);
    if (ids) {
      ids.delete(awarenessId);
      if (ids.size === 0) this.announcedPresence.delete(document);
    }
  }

  post(msg: DownstreamMessage, transfer?: Transferable[]): void {
    try {
      this.port.postMessage(msg, transfer ?? []);
    } catch {
      // Port may be closed
    }
  }

  respond(requestId: string, error?: string): void {
    this.post({ type: "response", requestId, error });
  }

  postProperties(connection: DirectConnection): void {
    this.post({
      type: "property",
      inFlightMessageCount: connection.inFlightMessageCount,
      destroyed: connection.destroyed,
      activeTransport: connection.activeTransport,
      availableTransports: connection.availableTransports,
    });
  }
}

class ManagedConnection {
  key: string;
  connection: DirectConnection;
  #networkTarget: EventTarget;
  #ports = new Set<PortState>();
  #unsubscribes: (() => void)[] = [];
  #currentOnline = true;
  #graceTimer: ReturnType<typeof setTimeout> | null = null;
  #gracePeriodMs: number;
  #fileHandler: FileClientHandlerInstance | null = null;
  #rpcClient: RpcClient | null = null;

  constructor(
    key: string,
    connection: DirectConnection,
    networkTarget: EventTarget,
    gracePeriodMs: number = DEFAULT_GRACE_PERIOD_MS,
  ) {
    this.key = key;
    this.connection = connection;
    this.#networkTarget = networkTarget;
    this.#gracePeriodMs = gracePeriodMs;
    this.#setupEventForwarding();
    this.#setupMessageFanOut();
  }

  buildDiagnostics() {
    return {
      ...this.connection.diagnostics,
      worker: {
        tabIds: [...this.#ports].map((p) => p.tabId),
        connectionKey: this.key,
        gracePeriodMs: this.#gracePeriodMs,
      },
    };
  }

  #getFileHandler() {
    if (!this.#fileHandler) {
      this.#rpcClient = new RpcClient(this.connection);
      const handlers = getFileClientHandlers();
      const handler = handlers.fileUpload as unknown as FileClientHandlerInstance;
      this.#fileHandler = handler;
      handler.setRpcClient(this.#rpcClient, async (msg: any) => {
        this.#rpcClient!.sendStream(msg);
      });

      const unsub = this.connection.on("received-message", (message) => {
        if (message.type === "rpc") {
          if ((message as any).requestType === "response") {
            handler.handleResponse(message as any);
          } else if ((message as any).requestType === "stream") {
            handler.handleStream(message as any);
          }
        } else if (message.type === "ack") {
          handler.handleAck(message as any);
        }
      });
      this.#unsubscribes.push(unsub);
    }
    return this.#fileHandler!;
  }

  async uploadFile(
    file: File,
    document: string,
    fileId?: string,
    encryptionKey?: CryptoKey,
  ): Promise<string> {
    await this.connection.connected;
    const handler = this.#getFileHandler();
    return handler.uploadFile(file, document, fileId, encryptionKey);
  }

  async downloadFile(
    fileId: string,
    document: string,
    encryptionKey?: CryptoKey,
    timeout?: number,
  ): Promise<File> {
    await this.connection.connected;
    const handler = this.#getFileHandler();
    return handler.downloadFile(fileId, document, encryptionKey, timeout);
  }

  get portCount(): number {
    return this.#ports.size;
  }

  addPort(portState: PortState): void {
    this.#ports.add(portState);
  }

  removePort(portState: PortState): void {
    this.#ports.delete(portState);
    this.reconcileOnlineState();
  }

  /** Deliver one tab's outgoing content message to the other tabs' receive path. */
  relayToSiblings(sender: PortState, encoded: Uint8Array): void {
    for (const port of this.#ports) {
      if (port === sender) continue;
      port.post({ type: "message", encoded });
    }
  }

  getStalePorts(now: number, thresholdMs: number): PortState[] {
    const stale: PortState[] = [];
    for (const port of this.#ports) {
      if (port.lastHeartbeat !== null && now - port.lastHeartbeat > thresholdMs) {
        stale.push(port);
      }
    }
    return stale;
  }

  scheduleGracePeriod(ms: number, onExpire: () => void): void {
    this.cancelGracePeriod();
    this.#graceTimer = setTimeout(onExpire, ms);
  }

  cancelGracePeriod(): void {
    if (this.#graceTimer !== null) {
      clearTimeout(this.#graceTimer);
      this.#graceTimer = null;
    }
  }

  reconcileOnlineState(): void {
    const anyOnline = this.#ports.size === 0 || [...this.#ports].some((p) => p.online);
    const wasOnline = this.#currentOnline;
    this.#currentOnline = anyOnline;
    if (anyOnline && !wasOnline) {
      this.#networkTarget.dispatchEvent(new Event("online"));
    }
    if (!anyOnline && wasOnline) {
      this.#networkTarget.dispatchEvent(new Event("offline"));
    }
  }

  #setupEventForwarding(): void {
    // `update` carries the full ConnectionState; the client derives its
    // `update`/`connected`/`disconnected` events from it (see
    // WorkerConnection.#updateState). Forwarding those three as generic events
    // too would double-fire them, so only `ping` and `messages-in-flight` —
    // which can't be reconstructed from the state — use the generic channel.
    const stateUnsub = this.connection.on("update", (state) => {
      this.#broadcast({ type: "state-update", state });
    });
    this.#unsubscribes.push(stateUnsub);

    const eventOnly = ["ping", "messages-in-flight", "diagnostic"] as const;
    for (const event of eventOnly) {
      const unsub = this.connection.on(event, (...args: unknown[]) => {
        this.#broadcast({ type: "event", event, args });
        if (event === "messages-in-flight") {
          for (const port of this.#ports) {
            port.postProperties(this.connection);
          }
        }
      });
      this.#unsubscribes.push(unsub);
    }

    // `connected`/`disconnected` don't need a generic event (the client derives
    // them from the state), but do need a fresh property snapshot pushed.
    for (const event of ["connected", "disconnected"] as const) {
      const unsub = this.connection.on(event, () => {
        for (const port of this.#ports) {
          port.postProperties(this.connection);
        }
      });
      this.#unsubscribes.push(unsub);
    }

    // sent-message needs special handling: Message objects can't survive
    // structured clone (they have getters, prototypes, cached state).
    // Forward the encoded bytes so the other side can reconstruct.
    const sentUnsub = this.connection.on("sent-message", (message: Message) => {
      // Guard: chunk streams are high-volume — copying each chunk to every
      // tab would undo the offload win. Transfers are observed via the file
      // protocol's progress events instead.
      if (message.type === "rpc" && (message as any).requestType === "stream") {
        return;
      }
      const encoded = message.encoded;
      for (const port of this.#ports) {
        port.post({
          type: "event",
          event: "sent-message",
          encoded: new Uint8Array(encoded),
        });
      }
    });
    this.#unsubscribes.push(sentUnsub);
  }

  #setupMessageFanOut(): void {
    const reader = this.connection.getReader();
    const iterate = async () => {
      for await (const batch of reader.source) {
        for (const message of batch) {
          const encoded = message.encoded;
          const ports = [...this.#ports];
          for (let i = 0; i < ports.length; i++) {
            if (i === ports.length - 1) {
              const buf = encoded.buffer.slice(
                encoded.byteOffset,
                encoded.byteOffset + encoded.byteLength,
              );
              const copy = new Uint8Array(buf);
              ports[i].post({ type: "message", encoded: copy }, [copy.buffer as ArrayBuffer]);
            } else {
              ports[i].post({ type: "message", encoded: new Uint8Array(encoded) });
            }
          }
        }
      }
    };
    iterate().catch((err) => {
      console.error("[ConnectionWorkerManager] message fan-out failed:", err);
    });
  }

  #broadcast(msg: DownstreamMessage): void {
    for (const port of this.#ports) {
      port.post(msg);
    }
  }

  destroy(): void {
    this.cancelGracePeriod();
    for (const unsub of this.#unsubscribes) {
      unsub();
    }
    this.#unsubscribes = [];
    if (this.#rpcClient) {
      this.#rpcClient.destroy();
      this.#rpcClient = null;
    }
    this.connection.destroy();
  }
}
