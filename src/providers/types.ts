import type { Message, RawReceivedMessage } from "teleportal";
import type { FanOutReader } from "teleportal/transports";

/**
 * Discriminated union representing the current state of a connection.
 */
export type ConnectionState =
  | { type: "connected"; transport: string }
  | { type: "disconnected" }
  | { type: "connecting"; transport: string }
  | { type: "errored"; error: Error };

/**
 * Event map for connection lifecycle and message events.
 *
 * Used by both {@link Connection} and concrete implementations to type
 * the Observable event system.
 */
export type ConnectionEvents = {
  update: (state: ConnectionState) => void;
  connected: () => void;
  disconnected: () => void;
  ping: () => void;
  "messages-in-flight": (hasInFlight: boolean) => void;
  "sent-message": (message: Message) => void;
  "received-message": (message: Message) => void;
};

/**
 * Abstract connection interface for Teleportal document synchronization.
 *
 * Implementations manage a network transport (WebSocket, HTTP, etc.), handle
 * reconnection, message batching/buffering, and fan-out to multiple
 * {@link import("./provider").Provider | Provider} instances.
 *
 * The default implementation is {@link import("./connection").DirectConnection | DirectConnection},
 * which runs the transport in the same thread. {@link import("./worker/worker-connection").WorkerConnection | WorkerConnection}
 * proxies all operations to a SharedWorker so multiple tabs share a single
 * underlying transport.
 */
export interface Connection {
  /** Where the connection runs: `"direct"` (in-thread) or `"worker"` (SharedWorker). */
  readonly hosting: "direct" | "worker";
  /** Current connection state. */
  readonly state: ConnectionState;
  /** Name of the active transport, or `null` if disconnected. */
  readonly activeTransport: string | null;
  /** Names of all registered transports. */
  readonly availableTransports: string[];
  /** Whether {@link destroy} has been called. */
  readonly destroyed: boolean;
  /** Number of sent messages awaiting server acknowledgement. */
  readonly inFlightMessageCount: number;
  /** Resolves when connected, rejects when errored. Re-created after disconnect. */
  readonly connected: Promise<void>;
  /** Send a message with in-flight tracking and batching. */
  send(message: Message): Promise<void>;
  /** Fire-and-forget send for high-throughput streams (e.g. file chunks). */
  sendStream(message: Message): void;
  /** Subscribe to incoming messages. Each reader receives all messages independently. */
  getReader(): FanOutReader<RawReceivedMessage>;
  /** Initiate connection (if not already connected). */
  connect(): Promise<void>;
  /** Manually disconnect. Prevents auto-reconnect until {@link connect} is called again. */
  disconnect(): Promise<void>;
  /** Switch to a different registered transport by name. */
  switchTransport(name: string): Promise<void>;
  /** Tear down the connection and release all resources. */
  destroy(): void | Promise<void>;
  /** Subscribe to a connection event. Returns an unsubscribe function. */
  on<K extends keyof ConnectionEvents>(event: K, callback: ConnectionEvents[K]): () => void;
}
