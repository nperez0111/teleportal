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
  if (type === "sync-step-1") return "bg-blue-500";
  if (type === "sync-step-2") return "bg-blue-600";
  if (type === "update") return "bg-green-500";
  if (type === "sync-done") return "bg-green-600";
  if (type === "auth-message") return "bg-red-500";
  if (type.startsWith("milestone-")) return "bg-purple-500";
  
  // Awareness
  if (type === "awareness-update") return "bg-yellow-500";
  if (type === "awareness-request") return "bg-yellow-600";
  
  // File
  if (type === "file-upload") return "bg-indigo-500";
  if (type === "file-download") return "bg-indigo-600";
  if (type === "file-part") return "bg-indigo-400";
  if (type === "file-auth-message") return "bg-red-600";
  
  // ACK
  if (type === "ack") return "bg-gray-500";
  
  return "bg-gray-400";
}

export function formatMessagePayload(message: MessageType): string {
  try {
    return JSON.stringify(message, null, 2);
  } catch (error) {
    return String(error);
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
