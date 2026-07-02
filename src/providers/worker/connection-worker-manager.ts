import { decodeMessage } from "teleportal/protocol";
import type { BinaryMessage, Message } from "teleportal";
import type { ConnectionTransport } from "../transports/types";
import { DirectConnection } from "../connection";
import { RpcClient } from "../rpc-client";
import { getFileClientHandlers, type FileClientHandlerInstance } from "../../protocols/file/transfer";
import type {
  DownstreamMessage,
  SerializedConnectionOptions,
  UpstreamMessage,
} from "./protocol";

const DEFAULT_GRACE_PERIOD_MS = 5_000;

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

  constructor(
    transportFactory: (desc: SerializedConnectionOptions) => ConnectionTransport[],
    options?: ConnectionWorkerManagerOptions,
  ) {
    this.#transportFactory = transportFactory;
    this.#gracePeriodMs = options?.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS;
    this.#getConnectionKey = options?.getConnectionKey ?? defaultConnectionKey;
  }

  addPort(port: MessagePort): void {
    const portState = new PortState(port);

    port.onmessage = (event: MessageEvent<UpstreamMessage>) => {
      this.#handleUpstream(event.data, portState);
    };

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
        conn.connection.send(decoded).catch(() => {});
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
        portState.post({ type: "heartbeat-ack" });
        break;

      case "file-upload": {
        const conn = portState.managedConnection;
        if (!conn) {
          portState.post({ type: "file-upload-error", requestId: msg.requestId, error: "No connection" });
          return;
        }
        conn
          .uploadFile(msg.file, msg.document, msg.fileId, msg.encryptionKey)
          .then((fileId) => portState.post({ type: "file-upload-result", requestId: msg.requestId, fileId }))
          .catch((e: Error) => portState.post({ type: "file-upload-error", requestId: msg.requestId, error: e.message }));
        break;
      }

      case "file-download": {
        const conn = portState.managedConnection;
        if (!conn) {
          portState.post({ type: "file-download-error", requestId: msg.requestId, error: "No connection" });
          return;
        }
        conn
          .downloadFile(msg.fileId, msg.document, msg.encryptionKey, msg.timeout)
          .then((file) => portState.post({ type: "file-download-result", requestId: msg.requestId, file }))
          .catch((e: Error) => portState.post({ type: "file-download-error", requestId: msg.requestId, error: e.message }));
        break;
      }
    }
  }

  #handleInit(
    options: SerializedConnectionOptions,
    tabId: string,
    portState: PortState,
  ): void {
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

      managed = new ManagedConnection(key, connection, networkTarget);
      this.#connections.set(key, managed);
    }

    managed.addPort(portState);
    portState.managedConnection = managed;

    portState.post({ type: "ready", state: managed.connection.state });
    portState.postProperties(managed.connection);
  }

  #handleDestroy(portState: PortState): void {
    const conn = portState.managedConnection;
    if (conn) {
      conn.removePort(portState);
      if (conn.portCount === 0) {
        conn.scheduleGracePeriod(this.#gracePeriodMs, () => {
          conn.destroy();
          this.#connections.delete(conn.key);
        });
      }
    }
    portState.port.close();
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

  constructor(port: MessagePort) {
    this.port = port;
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
  #fileHandler: FileClientHandlerInstance | null = null;
  #rpcClient: RpcClient | null = null;

  constructor(key: string, connection: DirectConnection, networkTarget: EventTarget) {
    this.key = key;
    this.connection = connection;
    this.#networkTarget = networkTarget;
    this.#setupEventForwarding();
    this.#setupMessageFanOut();
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

    const eventOnly = ["ping", "messages-in-flight"] as const;
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
              ports[i].post(
                { type: "message", encoded: copy },
                [copy.buffer as ArrayBuffer],
              );
            } else {
              ports[i].post({ type: "message", encoded: new Uint8Array(encoded) });
            }
          }
        }
      }
    };
    void iterate();
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
    this.connection.destroy();
  }
}
