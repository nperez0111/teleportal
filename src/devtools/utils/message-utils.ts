import { decoding } from "lib0";
import { toBase64 } from "lib0/buffer.js";
import type { Message, RawReceivedMessage } from "teleportal";

export type MessageType = Message | RawReceivedMessage;

export function getMessageTypeLabel(message: MessageType): string {
  if (message.type === "doc") {
    return message.payload.type;
  }
  if (message.type === "awareness") {
    return message.payload.type === "awareness-update"
      ? "awareness-update"
      : "awareness-request";
  }
  if (message.type === "file") {
    return message.payload.type;
  }
  if (message.type === "ack") {
    return "ack";
  }
  return "unknown";
}

export function getMessageTypeColor(message: MessageType): string {
  const type = getMessageTypeLabel(message);

  // Document message types
  if (type === "sync-step-1") return "devtools-bg-blue-500";
  if (type === "sync-step-2") return "devtools-bg-blue-600";
  if (type === "update") return "devtools-bg-green-500";
  if (type === "sync-done") return "devtools-bg-green-600";
  if (type === "auth-message") return "devtools-bg-red-500";
  if (type.startsWith("milestone-")) return "devtools-bg-purple-500";

  // Awareness
  if (type === "awareness-update") return "devtools-bg-yellow-500";
  if (type === "awareness-request") return "devtools-bg-yellow-600";

  // File
  if (type === "file-upload") return "devtools-bg-indigo-500";
  if (type === "file-download") return "devtools-bg-indigo-600";
  if (type === "file-part") return "devtools-bg-indigo-400";
  if (type === "file-auth-message") return "devtools-bg-red-600";

  // ACK
  if (type === "ack") return "devtools-bg-gray-500";

  return "devtools-bg-gray-400";
}

export function formatMessagePayload(message: MessageType): string | null {
  switch (message.type) {
    case "ack": {
      return `ACK(id: ${message.id}, acknowledged: ${message.payload.messageId})`;
    }
    case "awareness": {
      switch (message.payload.type) {
        case "awareness-update": {
          try {
            const decoder = decoding.createDecoder(message.payload.update);
            const len = decoding.readVarUint(decoder);
            const clients = [];
            for (let i = 0; i < len; i++) {
              const clientID = decoding.readVarUint(decoder);
              const clock = decoding.readVarUint(decoder);
              const state = JSON.parse(decoding.readVarString(decoder));
              clients.push({ clientID, clock, state });
            }

            return JSON.stringify(clients, null, 2);
          } catch (err) {
            console.error("Failed to decode awareness update:", err);
            return toBase64(message.payload.update);
          }
        }
        case "awareness-request": {
          return null;
        }
      }
    }
    case "file": {
      switch (message.payload.type) {
        case "file-upload": {
          return JSON.stringify(message.payload, null, 2);
        }
        case "file-download": {
          return JSON.stringify(message.payload, null, 2);
        }
        case "file-part": {
          return JSON.stringify(
            { ...message.payload, chunkData: "<chunk data>" },
            null,
            2,
          );
        }
        case "file-auth-message": {
          return JSON.stringify(message.payload, null, 2);
        }
        default: {
          return null;
        }
      }
    }
    case "doc": {
      switch (message.payload.type) {
        case "sync-step-1": {
          return toBase64(message.payload.sv);
        }
        case "sync-step-2": {
          return toBase64(message.payload.update);
        }
        case "update": {
          return toBase64(message.payload.update);
        }
        case "sync-done": {
          return null;
        }
        case "auth-message": {
          return JSON.stringify(message.payload, null, 2);
        }
        case "milestone-list-request": {
          return message.payload.snapshotIds.join(",");
        }
        case "milestone-list-response": {
          return JSON.stringify(message.payload.milestones, null, 2);
        }
        case "milestone-snapshot-request": {
          return message.payload.milestoneId;
        }
        default: {
          return null;
        }
      }
    }
    default: {
      // @ts-expect-error - this should be unreachable due to type checking
      throw new Error(`Unknown message type: ${message.type}`);
    }
  }
}

export function isDocumentMessage(message: MessageType): boolean {
  return message.type === "doc";
}

export function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString();
}

export function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (seconds < 60) return `${seconds}s ago`;
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return new Date(timestamp).toLocaleDateString();
}
