import { Observable, type BinaryMessage, type Message, type RawReceivedMessage } from "teleportal";
import { decodeMessage } from "teleportal/protocol";
import { createFanOutWriter, type FanOutReader } from "teleportal/transports";
import type { ConnectionDiagnostics, ConnectionState, ConnectionEvents } from "../types";
import type { DownstreamMessage, UpstreamMessage } from "./protocol";

const RPC_TIMEOUT_MS = 30_000;

export class WorkerConnection extends Observable<ConnectionEvents> {
  readonly hosting = "worker" as const;

  #port: MessagePort;
  #fanOutWriter = createFanOutWriter<RawReceivedMessage>();

  #state: ConnectionState = { type: "disconnected" };
  #activeTransport: string | null = null;
  #availableTransports: string[] = [];
  #destroyed = false;
  #inFlightMessageCount = 0;
  #diagnostics: ConnectionDiagnostics | null = null;

  #connectedPromise: Promise<void> | null = null;
  #connectedResolve: (() => void) | null = null;
  #connectedReject: ((error: Error) => void) | null = null;

  #pendingRequests = new Map<
    string,
    {
      resolve: () => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  #nextRequestId = 0;

  #pendingFileOps = new Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
    }
  >();

  #heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  #missedHeartbeats = 0;
  #onWorkerDeath?: () => void;
  #onlineHandler: (() => void) | null = null;
  #offlineHandler: (() => void) | null = null;
  #pagehideHandler: ((event: Event) => void) | null = null;

  constructor(port: MessagePort, options?: { onWorkerDeath?: () => void }) {
    super();
    this.#port = port;
    this.#onWorkerDeath = options?.onWorkerDeath;

    port.onmessage = (event: MessageEvent<DownstreamMessage>) => {
      this.#handleMessage(event.data);
    };

    port.start?.();
  }

  #handleMessage(msg: DownstreamMessage): void {
    switch (msg.type) {
      case "ready":
      case "state-update":
        this.#updateState(msg.state);
        break;

      case "event":
        this.#handleEvent(msg);
        break;

      case "message": {
        const decoded = decodeMessage(msg.encoded as BinaryMessage);
        this.#fanOutWriter.send(decoded);
        this.call("received-message", decoded);
        break;
      }

      case "property":
        this.#inFlightMessageCount = msg.inFlightMessageCount;
        this.#destroyed = msg.destroyed;
        this.#activeTransport = msg.activeTransport;
        this.#availableTransports = msg.availableTransports;
        break;

      case "response": {
        const pending = this.#pendingRequests.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.#pendingRequests.delete(msg.requestId);
          if (msg.error) {
            pending.reject(new Error(msg.error));
          } else {
            pending.resolve();
          }
        }
        break;
      }

      case "heartbeat-ack":
        this.#missedHeartbeats = 0;
        break;

      case "diagnostics":
        this.#diagnostics = msg.diagnostics;
        break;

      case "file-upload-result": {
        const op = this.#pendingFileOps.get(msg.requestId);
        if (op) {
          this.#pendingFileOps.delete(msg.requestId);
          op.resolve(msg.fileId);
        }
        break;
      }

      case "file-upload-error": {
        const op = this.#pendingFileOps.get(msg.requestId);
        if (op) {
          this.#pendingFileOps.delete(msg.requestId);
          op.reject(new Error(msg.error));
        }
        break;
      }

      case "file-download-result": {
        const op = this.#pendingFileOps.get(msg.requestId);
        if (op) {
          this.#pendingFileOps.delete(msg.requestId);
          op.resolve(msg.file);
        }
        break;
      }

      case "file-download-error": {
        const op = this.#pendingFileOps.get(msg.requestId);
        if (op) {
          this.#pendingFileOps.delete(msg.requestId);
          op.reject(new Error(msg.error));
        }
        break;
      }
    }
  }

  #handleEvent(msg: DownstreamMessage & { type: "event" }): void {
    const { event } = msg;
    if (event === "sent-message" && "encoded" in msg && msg.encoded) {
      const decoded = decodeMessage(msg.encoded as BinaryMessage);
      this.call("sent-message", decoded);
      return;
    }
    (this as any).call(event, ...(msg.args ?? []));
  }

  // `#updateState` is the *sole* emitter of the `update`/`connected`/
  // `disconnected` events on the client side. The worker forwards state via
  // `ready`/`state-update` messages (not as generic events) precisely so these
  // aren't dispatched twice — see ConnectionWorkerManager.#setupEventForwarding.
  // The transition conditions mirror DirectConnection.#setState.
  #updateState(newState: ConnectionState): void {
    const prev = this.#state;
    this.#state = newState;

    if (newState.type === "connected") {
      if (this.#connectedResolve) {
        this.#connectedResolve();
        this.#connectedPromise = null;
        this.#connectedResolve = null;
        this.#connectedReject = null;
      }
      if (prev.type !== "connected") {
        this.call("connected");
      }
    } else if (newState.type === "disconnected") {
      // Matches DirectConnection: emit on any transition into `disconnected`
      // (e.g. `connecting` → `disconnected`), not just from `connected`. The
      // `connected` promise is left pending so it resolves on a later reconnect
      // rather than hanging its awaiters.
      if (prev.type !== "disconnected") {
        this.call("disconnected");
      }
    } else if (newState.type === "errored") {
      if (this.#connectedReject) {
        this.#connectedReject(newState.error);
        this.#connectedPromise = null;
        this.#connectedResolve = null;
        this.#connectedReject = null;
      }
    }

    this.call("update", newState);
  }

  #postUpstream(msg: UpstreamMessage, transfer?: Transferable[]): void {
    this.#port.postMessage(msg, transfer ?? []);
  }

  #rpc(msg: UpstreamMessage & { requestId: string }): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingRequests.delete(msg.requestId);
        reject(new Error(`Worker RPC "${msg.type}" timed out after ${RPC_TIMEOUT_MS}ms`));
      }, RPC_TIMEOUT_MS);
      this.#pendingRequests.set(msg.requestId, { resolve, reject, timer });
      this.#postUpstream(msg);
    });
  }

  #transferEncoded(encoded: Uint8Array): { copy: Uint8Array; transfer: Transferable[] } {
    const buf = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
    const copy = new Uint8Array(buf);
    return { copy, transfer: [copy.buffer as ArrayBuffer] };
  }

  // --- Public API (mirrors Connection) ---

  get state(): ConnectionState {
    return this.#state;
  }

  get activeTransport(): string | null {
    return this.#activeTransport;
  }

  get availableTransports(): string[] {
    return this.#availableTransports;
  }

  get destroyed(): boolean {
    return this.#destroyed;
  }

  get inFlightMessageCount(): number {
    return this.#inFlightMessageCount;
  }

  /** Consecutive tab↔worker heartbeats without an ack (resets on each ack). */
  get missedHeartbeats(): number {
    return this.#missedHeartbeats;
  }

  /**
   * Last diagnostics snapshot received from the worker. Reading it requests a
   * fresh snapshot, so pollers (e.g. devtools) see at-most-one-read-stale data.
   */
  get diagnostics(): ConnectionDiagnostics {
    if (!this.#destroyed) {
      this.#postUpstream({ type: "get-diagnostics" });
    }
    return (
      this.#diagnostics ?? {
        batchIntervalMs: 0,
        maxBatchIntervalMs: 0,
        bufferedMessageCount: 0,
        reconnectAttempt: 0,
        maxReconnectAttempts: 0,
        online: true,
      }
    );
  }

  get connected(): Promise<void> {
    if (this.#state.type === "connected") return Promise.resolve();
    if (this.#state.type === "errored") return Promise.reject(this.#state.error);

    if (!this.#connectedPromise) {
      this.#connectedPromise = new Promise((resolve, reject) => {
        this.#connectedResolve = resolve;
        this.#connectedReject = reject;
      });
    }
    return this.#connectedPromise;
  }

  getReader(): FanOutReader<RawReceivedMessage> {
    return this.#fanOutWriter.getReader();
  }

  async send(message: Message): Promise<void> {
    if (this.#destroyed) return;
    const { copy, transfer } = this.#transferEncoded(message.encoded);
    this.#postUpstream({ type: "send", encoded: copy }, transfer);
  }

  sendStream(message: Message): void {
    if (this.#destroyed) return;
    const { copy, transfer } = this.#transferEncoded(message.encoded);
    this.#postUpstream({ type: "send-stream", encoded: copy }, transfer);
  }

  async connect(): Promise<void> {
    const requestId = String(this.#nextRequestId++);
    await this.#rpc({ type: "connect", requestId });
    return this.connected;
  }

  async disconnect(): Promise<void> {
    const requestId = String(this.#nextRequestId++);
    await this.#rpc({ type: "disconnect", requestId });
  }

  async switchTransport(transport: string): Promise<void> {
    const requestId = String(this.#nextRequestId++);
    await this.#rpc({ type: "switch-transport", transport, requestId });
  }

  async destroy(): Promise<void> {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#stopHeartbeat();
    this.#stopListeningForNetworkStatus();
    this.#stopListeningForPageHide();
    this.#postUpstream({ type: "destroy", tabId: "" });
    this.#fanOutWriter.close();
    this.#port.close();
    for (const [, pending] of this.#pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Connection destroyed"));
    }
    this.#pendingRequests.clear();
    for (const [, op] of this.#pendingFileOps) {
      op.reject(new Error("Connection destroyed"));
    }
    this.#pendingFileOps.clear();
    this.#connectedReject?.(new Error("Connection destroyed"));
    super.destroy();
  }

  // --- File operations (offloaded to worker) ---

  uploadFile(
    file: File,
    document: string,
    options?: { fileId?: string; encryptionKey?: CryptoKey },
  ): Promise<string> {
    const requestId = String(this.#nextRequestId++);
    return new Promise((resolve, reject) => {
      this.#pendingFileOps.set(requestId, { resolve, reject });
      this.#postUpstream({
        type: "file-upload",
        requestId,
        file,
        document,
        fileId: options?.fileId,
        encryptionKey: options?.encryptionKey,
      });
    });
  }

  downloadFile(
    fileId: string,
    document: string,
    options?: { encryptionKey?: CryptoKey; timeout?: number },
  ): Promise<File> {
    const requestId = String(this.#nextRequestId++);
    return new Promise((resolve, reject) => {
      this.#pendingFileOps.set(requestId, { resolve, reject });
      this.#postUpstream({
        type: "file-download",
        requestId,
        fileId,
        document,
        encryptionKey: options?.encryptionKey,
        timeout: options?.timeout,
      });
    });
  }

  // --- Init ---

  init(options: import("./protocol").SerializedConnectionOptions, tabId: string): void {
    this.#postUpstream({ type: "init", options, tabId });
  }

  // --- Network status forwarding ---

  forwardNetworkStatus(online: boolean): void {
    this.#postUpstream({ type: "network-status", online });
  }

  listenForNetworkStatus(): void {
    this.#stopListeningForNetworkStatus();
    if (typeof globalThis.addEventListener !== "function") return;
    this.#onlineHandler = () => this.forwardNetworkStatus(true);
    this.#offlineHandler = () => this.forwardNetworkStatus(false);
    globalThis.addEventListener("online", this.#onlineHandler);
    globalThis.addEventListener("offline", this.#offlineHandler);
  }

  #stopListeningForNetworkStatus(): void {
    if (this.#onlineHandler) {
      globalThis.removeEventListener("online", this.#onlineHandler);
      this.#onlineHandler = null;
    }
    if (this.#offlineHandler) {
      globalThis.removeEventListener("offline", this.#offlineHandler);
      this.#offlineHandler = null;
    }
  }

  // --- Page lifecycle ---

  /**
   * Destroy the connection when the page is being discarded, so the worker
   * releases this tab's port (and retracts its presence) immediately instead
   * of waiting for the port `close` event or the stale sweep. Skipped when the
   * page enters the back/forward cache (`persisted`), since it may come back
   * with this connection still live.
   */
  listenForPageHide(): void {
    this.#stopListeningForPageHide();
    if (typeof globalThis.addEventListener !== "function") return;
    this.#pagehideHandler = (event: Event) => {
      if ((event as PageTransitionEvent).persisted) return;
      void this.destroy();
    };
    globalThis.addEventListener("pagehide", this.#pagehideHandler);
  }

  #stopListeningForPageHide(): void {
    if (this.#pagehideHandler) {
      globalThis.removeEventListener("pagehide", this.#pagehideHandler);
      this.#pagehideHandler = null;
    }
  }

  // --- Heartbeat ---

  startHeartbeat(intervalMs = 5000, maxMisses = 2): void {
    this.#stopHeartbeat();
    this.#missedHeartbeats = 0;
    this.#heartbeatInterval = setInterval(() => {
      this.#missedHeartbeats++;
      if (this.#missedHeartbeats > maxMisses) {
        this.#stopHeartbeat();
        this.#updateState({ type: "errored", error: new Error("Worker heartbeat timeout") });
        this.#onWorkerDeath?.();
        return;
      }
      this.#postUpstream({ type: "heartbeat" });
    }, intervalMs);
  }

  #stopHeartbeat(): void {
    if (this.#heartbeatInterval) {
      clearInterval(this.#heartbeatInterval);
      this.#heartbeatInterval = null;
    }
  }
}
