import type { ConnectionState } from "../types";

// ---------------------------------------------------------------------------
// MessagePort protocol — shared between main thread and worker
// ---------------------------------------------------------------------------

// Main thread → Worker (upstream)

export type UpstreamMessage =
  | { type: "init"; options: SerializedConnectionOptions; tabId: string }
  | { type: "send"; encoded: Uint8Array }
  | { type: "send-stream"; encoded: Uint8Array }
  | { type: "connect"; requestId: string }
  | { type: "disconnect"; requestId: string }
  | { type: "switch-transport"; transport: string; requestId: string }
  | { type: "destroy"; tabId: string }
  | { type: "network-status"; online: boolean }
  | { type: "heartbeat" }
  | {
      type: "file-upload";
      requestId: string;
      file: File;
      document: string;
      fileId?: string;
      encryptionKey?: CryptoKey;
    }
  | {
      type: "file-download";
      requestId: string;
      fileId: string;
      document: string;
      encryptionKey?: CryptoKey;
      timeout?: number;
    };

// Worker → Main thread (downstream)

export type DownstreamMessage =
  | { type: "ready"; state: ConnectionState }
  | { type: "state-update"; state: ConnectionState }
  | { type: "event"; event: string; encoded?: Uint8Array; args?: unknown[] }
  | { type: "message"; encoded: Uint8Array }
  | {
      type: "property";
      inFlightMessageCount: number;
      destroyed: boolean;
      activeTransport: string | null;
      availableTransports: string[];
    }
  | { type: "response"; requestId: string; error?: string }
  | { type: "heartbeat-ack" }
  | { type: "file-upload-result"; requestId: string; fileId: string }
  | { type: "file-upload-error"; requestId: string; error: string }
  | { type: "file-download-result"; requestId: string; file: File }
  | { type: "file-download-error"; requestId: string; error: string };

// ---------------------------------------------------------------------------
// Serializable transport descriptors
// ---------------------------------------------------------------------------

export interface TransportDescriptor {
  type: string;
  options?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Serializable connection options — no closures
// ---------------------------------------------------------------------------

export type SerializedConnectionOptions = {
  url?: string;
  transports?: TransportDescriptor[];
  token?: string;
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
};
