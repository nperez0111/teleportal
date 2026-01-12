import type {
  FilterConfig,
  MessageEntry,
  MessageTypeConfig,
  PeerState,
} from "./types.js";

/**
 * Format a timestamp as a relative time string (e.g., "2s ago", "5m ago")
 */
export function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) {
    return `${seconds}s ago`;
  } else if (minutes < 60) {
    return `${minutes}m ago`;
  } else if (hours < 24) {
    return `${hours}h ago`;
  } else {
    return `${days}d ago`;
  }
}

/**
 * Format a timestamp as a readable date/time string
 */
export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

/**
 * Format bytes to human-readable string
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

/**
 * Get message type key for filtering (e.g., "doc:update", "awareness:awareness-update")
 */
export function getMessageTypeKey(message: MessageEntry["message"]): string {
  if (message.type === "doc") {
    const payload = message.payload as { type?: string };
    return `doc:${payload.type ?? "unknown"}`;
  } else if (message.type === "awareness") {
    const payload = message.payload as { type?: string };
    return `awareness:${payload.type ?? "unknown"}`;
  } else {
    return message.type;
  }
}

/**
 * Get display info for a message type
 */
export function getMessageDisplayInfo(
  message: MessageEntry["message"],
  messageTypes: MessageTypeConfig[],
): MessageTypeConfig {
  const key = getMessageTypeKey(message);
  const found = messageTypes.find((mt) => {
    const mtKey = `${mt.type}:${mt.payloadType ?? ""}`;
    return mtKey === key || (mt.payloadType === undefined && mt.type === message.type);
  });
  return (
    found ?? {
      type: message.type as any,
      icon: "📄",
      label: message.type,
    }
  );
}

/**
 * Filter messages based on filter configuration
 */
export function filterMessages(
  messages: MessageEntry[],
  filters: FilterConfig,
): MessageEntry[] {
  return messages.filter((entry) => {
    // Direction filter
    if (filters.direction !== "all" && entry.direction !== filters.direction) {
      return false;
    }

    // Message type filter
    if (filters.messageTypes.size > 0) {
      const typeKey = getMessageTypeKey(entry.message);
      if (!filters.messageTypes.has(typeKey)) {
        return false;
      }
    }

    // Document ID filter
    if (filters.documentIds.size > 0) {
      if (!entry.documentId || !filters.documentIds.has(entry.documentId)) {
        return false;
      }
    }

    // Search filter
    if (filters.search) {
      const searchLower = filters.search.toLowerCase();
      const messageId = entry.message.id.toLowerCase();
      const documentId = (entry.documentId ?? "").toLowerCase();
      const payloadStr = JSON.stringify(entry.message.payload).toLowerCase();

      if (
        !messageId.includes(searchLower) &&
        !documentId.includes(searchLower) &&
        !payloadStr.includes(searchLower)
      ) {
        return false;
      }
    }

    // Date range filter
    if (filters.dateRange) {
      if (
        entry.timestamp < filters.dateRange.start ||
        entry.timestamp > filters.dateRange.end
      ) {
        return false;
      }
    }

    return true;
  });
}

/**
 * Count messages by type
 */
export function countMessagesByType(
  messages: MessageEntry[],
  messageTypes: MessageTypeConfig[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of messages) {
    const key = getMessageTypeKey(entry.message);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Truncate a string to a maximum length
 */
export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + "...";
}

/**
 * Truncate document ID for display
 */
export function truncateDocId(docId: string, maxLength: number = 20): string {
  return truncate(docId, maxLength);
}

/**
 * Format message payload as JSON string
 */
export function formatMessagePayload(payload: unknown): string {
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

/**
 * Convert Uint8Array to hex string
 */
export function uint8ArrayToHex(arr: Uint8Array): string {
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
}

/**
 * Get all unique document IDs from messages
 */
export function getDocumentIds(messages: MessageEntry[]): Set<string> {
  const docIds = new Set<string>();
  for (const entry of messages) {
    if (entry.documentId) {
      docIds.add(entry.documentId);
    }
  }
  return docIds;
}

/**
 * Get peers for a specific document
 */
export function getPeersForDocument(
  peers: Map<number, PeerState>,
  documentId: string,
): PeerState[] {
  const result: PeerState[] = [];
  for (const peer of peers.values()) {
    if (peer.documents.has(documentId)) {
      result.push(peer);
    }
  }
  return result;
}

/**
 * Calculate message size in bytes
 */
export function calculateMessageSize(message: MessageEntry["message"]): number {
  try {
    const encoded = message.encoded;
    if (encoded instanceof Uint8Array) {
      return encoded.length;
    }
    // Fallback: estimate from JSON
    return new TextEncoder().encode(JSON.stringify(message)).length;
  } catch {
    return 0;
  }
}

/**
 * Debounce function
 */
export function debounce<T extends (...args: any[]) => void>(
  fn: T,
  delay: number,
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  return (...args: Parameters<T>) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      fn(...args);
    }, delay);
  };
}
