import { DirectConnection } from "../connection";
import type { Connection } from "../types";
import type { ConnectionTransport, TokenOptions } from "../transports/types";
import { WorkerConnection } from "./worker-connection";
import type { SerializedConnectionOptions, TransportDescriptor } from "./protocol";

export interface CreateConnectionOptions {
  /**
   * URL of the SharedWorker script. When provided and `SharedWorker` is
   * available in the browser, the connection is offloaded to a shared worker
   * so all tabs share a single transport.
   *
   * When omitted or `SharedWorker` is not available, a direct in-thread
   * connection is created using {@link transports} instead.
   */
  workerUrl?: string | URL;

  /** Server URL. */
  url: string;

  /** Authentication token. */
  token?: TokenOptions;

  /**
   * Real transport instances for the direct (non-worker) fallback path.
   * Required — there is no default. The caller decides which transports to use.
   */
  transports: ConnectionTransport[];

  /**
   * Serializable transport descriptors forwarded to the SharedWorker.
   * The worker script maps these to real transport instances on its side.
   *
   * When omitted the worker uses its own defaults (typically websocket + http).
   */
  workerTransports?: TransportDescriptor[];

  /** Called if the SharedWorker crashes. */
  onWorkerDeath?: () => void;

  connect?: boolean;
  maxReconnectAttempts?: number;
  initialReconnectDelay?: number;
  maxBackoffTime?: number;
  reconnectBackoffFactor?: number;
  heartbeatInterval?: number;
  messageReconnectTimeout?: number;
  batchIntervalMs?: number;
  maxBatchIntervalMs?: number;
}

/**
 * Create a {@link Connection} with automatic SharedWorker offloading.
 *
 * When `workerUrl` is provided and the browser supports `SharedWorker`,
 * returns a {@link WorkerConnection} that proxies all operations to a shared
 * worker. Tabs share one underlying transport when their connections resolve to
 * the same pooling key inside the worker — by default keyed on URL + token, so
 * different authors stay isolated (see `ConnectionWorkerManager`'s
 * `getConnectionKey`). Online/offline events are forwarded automatically, and a
 * heartbeat monitors worker liveness.
 *
 * Otherwise creates a {@link DirectConnection} using the provided
 * `transports` in the current thread.
 *
 * ```ts
 * import { createConnection } from "teleportal/providers/worker";
 * import { websocketTransport, httpTransport } from "teleportal/providers";
 *
 * const connection = createConnection({
 *   workerUrl: new URL("./worker.ts", import.meta.url),
 *   url: "wss://example.com/sync",
 *   token: { token: jwt },
 *   transports: [websocketTransport(), httpTransport()],
 * });
 * ```
 */
export function createConnection(options: CreateConnectionOptions): Connection {
  if (options.workerUrl && typeof SharedWorker !== "undefined") {
    try {
      return createWorkerConn(options);
    } catch {
      // SharedWorker construction can fail (CSP, file:// origin, etc.)
    }
  }
  return createDirectConn(options);
}

function createWorkerConn(options: CreateConnectionOptions): WorkerConnection {
  const worker = new SharedWorker(options.workerUrl!, {
    type: "module",
    name: "teleportal",
  });

  worker.onerror = (event) => {
    options.onWorkerDeath?.();
    console.error("[teleportal] SharedWorker script failed to load:", event);
  };

  const conn = new WorkerConnection(worker.port, {
    onWorkerDeath: options.onWorkerDeath,
  });

  const serialized: SerializedConnectionOptions = {
    url: options.url,
    transports: options.workerTransports,
    token: options.token?.token,
    connect: options.connect ?? true,
    maxReconnectAttempts: options.maxReconnectAttempts,
    initialReconnectDelay: options.initialReconnectDelay,
    maxBackoffTime: options.maxBackoffTime,
    reconnectBackoffFactor: options.reconnectBackoffFactor,
    heartbeatInterval: options.heartbeatInterval,
    messageReconnectTimeout: options.messageReconnectTimeout,
    batchIntervalMs: options.batchIntervalMs,
    maxBatchIntervalMs: options.maxBatchIntervalMs,
  };

  conn.init(serialized, crypto.randomUUID());
  conn.listenForNetworkStatus();
  conn.startHeartbeat();
  return conn;
}

function createDirectConn(options: CreateConnectionOptions): DirectConnection {
  return new DirectConnection({
    url: options.url,
    transports: options.transports,
    token: options.token,
    connect: options.connect,
    maxReconnectAttempts: options.maxReconnectAttempts,
    initialReconnectDelay: options.initialReconnectDelay,
    maxBackoffTime: options.maxBackoffTime,
    reconnectBackoffFactor: options.reconnectBackoffFactor,
    heartbeatInterval: options.heartbeatInterval,
    messageReconnectTimeout: options.messageReconnectTimeout,
    batchIntervalMs: options.batchIntervalMs,
    maxBatchIntervalMs: options.maxBatchIntervalMs,
  });
}
