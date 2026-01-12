import type { MessageEntry } from "./event-client.js";
import type { MessageTypeConfig } from "./panel-types.js";

export function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return (
    date.toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }) +
    "." +
    String(date.getMilliseconds()).padStart(3, "0")
  );
}

export function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  if (diff < 1000) return "now";
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

export function formatUptime(startTime: number): string {
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  if (elapsed < 60) return `${elapsed}s`;
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
  return `${Math.floor(elapsed / 3600)}h ${Math.floor((elapsed % 3600) / 60)}m`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export function truncateDocId(docId: string): string {
  if (docId.length <= 12) return docId;
  return docId.slice(0, 6) + "..." + docId.slice(-4);
}

export function truncateId(id: string, length: number = 8): string {
  if (id.length <= length) return id;
  return id.slice(0, length) + "...";
}

export function getMessageTypeKey(message: MessageEntry["message"]): string {
  return `${message.type}:${message.payload?.type || ""}`;
}

export function getMessageDisplayInfo(message: MessageEntry["message"]): {
  icon: string;
  label: string;
} {
  const type = message.type;
  const payloadType = message.payload?.type;

  if (type === "doc") {
    switch (payloadType) {
      case "sync-step-1":
        return { icon: "🔄", label: "Sync Step 1" };
      case "sync-step-2":
        return { icon: "🔄", label: "Sync Step 2" };
      case "sync-done":
        return { icon: "✅", label: "Sync Done" };
      case "update":
        return { icon: "📝", label: "Update" };
      case "auth-message":
        return { icon: "🔐", label: "Auth" };
      case "milestone-list-request":
        return { icon: "📋", label: "Milestone List Request" };
      case "milestone-list-response":
        return { icon: "📋", label: "Milestone List Response" };
      case "milestone-snapshot-request":
        return { icon: "📸", label: "Milestone Snapshot Request" };
      case "milestone-snapshot-response":
        return { icon: "📸", label: "Milestone Snapshot Response" };
      case "milestone-create-request":
        return { icon: "➕", label: "Milestone Create Request" };
      case "milestone-create-response":
        return { icon: "➕", label: "Milestone Create Response" };
      case "milestone-update-name-request":
        return { icon: "✏️", label: "Milestone Update Name" };
      default:
        return { icon: "📄", label: payloadType || "Doc" };
    }
  }

  if (type === "awareness") {
    switch (payloadType) {
      case "awareness-update":
        return { icon: "👥", label: "Awareness Update" };
      case "awareness-request":
        return { icon: "👥", label: "Awareness Request" };
      default:
        return { icon: "👥", label: "Awareness" };
    }
  }

  if (type === "ack") return { icon: "✓", label: "Ack" };
  if (type === "file") {
    switch (payloadType) {
      case "file-upload":
        return { icon: "📤", label: "File Upload" };
      case "file-download":
        return { icon: "📥", label: "File Download" };
      case "file-part":
        return { icon: "📦", label: "File Part" };
      case "file-auth-message":
        return { icon: "🔐", label: "File Auth" };
      default:
        return { icon: "📁", label: "File" };
    }
  }

  return { icon: "📨", label: type || "Message" };
}

export function formatMessageDetail(message: MessageEntry["message"]): string {
  try {
    return message.toString();
  } catch {
    return String(message);
  }
}

export function filterMessages(
  entries: MessageEntry[],
  filters: {
    direction: "all" | "sent" | "received";
    types: Set<string>;
    search: string;
  },
): MessageEntry[] {
  return entries.filter((entry) => {
    if (entry.message.type === "ack") return false;

    if (filters.direction !== "all" && entry.direction !== filters.direction) {
      return false;
    }

    const typeKey = getMessageTypeKey(entry.message);
    if (filters.types.size > 0 && !filters.types.has(typeKey)) {
      return false;
    }

    if (filters.search) {
      const searchLower = filters.search.toLowerCase();
      const messageStr = JSON.stringify(entry.message).toLowerCase();
      if (!messageStr.includes(searchLower)) {
        return false;
      }
    }

    return true;
  });
}

export function countMessagesByType(
  entries: MessageEntry[],
  typeConfigs: MessageTypeConfig[],
): Map<string, number> {
  const counts = new Map<string, number>();

  for (const entry of entries) {
    if (entry.message.type === "ack") continue;
    const key = getMessageTypeKey(entry.message);
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  return counts;
}

export function getThemeIcon(theme: "system" | "light" | "dark"): string {
  if (theme === "dark") {
    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>';
  }
  if (theme === "light") {
    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>';
  }
  return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
}

export function getThemeLabel(theme: "system" | "light" | "dark"): string {
  return theme.charAt(0).toUpperCase() + theme.slice(1);
}
