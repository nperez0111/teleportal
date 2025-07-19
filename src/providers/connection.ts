import type { BinaryMessage, Observable } from "teleportal";
import { FanOutReader } from "teleportal/transports";

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
 * An abstraction over a connection of a provider.
 */
export interface Connection<Context extends ConnectionContext>
  extends Observable<{
    update: (state: ConnectionState<Context>) => void;
    message: (message: BinaryMessage) => void;
    connected: () => void;
    disconnected: () => void;
  }> {
  /**
   * Send a message to the connection.
   */
  send(message: BinaryMessage): void;
  /**
   * Connect to the underlying connection
   */
  connect(): Promise<void>;
  /**
   * Disconnect from the connection
   */
  disconnect(): Promise<void>;
  /**
   * The current state of the connection
   */
  get state(): ConnectionState<Context>;
  /**
   * Get a reader for the connection (based on {@link FanOutReader})
   */
  getReader(): FanOutReader<BinaryMessage>;
  /**
   * A promise that resolves when the connection is connected
   */
  get connected(): Promise<void>;
  /**
   * Destroy the connection
   */
  destroy(): void;
  /**
   * Whether the connection is destroyed
   */
  destroyed: boolean;
}
