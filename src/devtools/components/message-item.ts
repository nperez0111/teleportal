import type { DevtoolsMessage } from "../types";
import {
  getMessageTypeLabel,
  getMessageTypeColor,
  formatTimestamp,
  formatDuration,
  getAckLatencyLevel,
} from "../utils/message-utils";
import { cloneSvg, ICON_ARROW_SENT, ICON_ARROW_RECEIVED } from "../utils/svg-cache";

export function createAckBadge(message: DevtoolsMessage): HTMLElement | null {
  if (!message.ackedBy) return null;
  const latency = Math.max(0, message.ackedBy.timestamp - message.timestamp);
  const badge = document.createElement("span");
  badge.className = `devtools-ack-indicator devtools-ack-${getAckLatencyLevel(latency)}`;
  badge.textContent = `✓ ${formatDuration(latency)}`;
  badge.title = `Acknowledged after ${latency}ms`;
  return badge;
}

export function createMessageItem(
  message: DevtoolsMessage,
  isSelected: boolean,
  onClick: () => void,
  options?: { child?: boolean },
): HTMLElement {
  const item = document.createElement("div");
  item.className = `devtools-px-2 devtools-py-1.5 devtools-border-b devtools-border-gray-200 devtools-cursor-pointer devtools-hover:bg-gray-50 devtools-transition-colors devtools-text-xs ${
    isSelected ? "devtools-bg-blue-50" : ""
  }${options?.child ? " devtools-child-row" : ""}`;
  item.addEventListener("click", onClick);

  const typeLabel = getMessageTypeLabel(message.message);
  const typeColor = getMessageTypeColor(message.message);

  const container = document.createElement("div");
  container.className = "devtools-message-row";

  // Direction icon
  const directionEl = document.createElement("div");
  directionEl.className = `devtools-direction-icon ${message.direction === "sent" ? "devtools-direction-sent" : "devtools-direction-received"}`;
  directionEl.title = message.direction === "sent" ? "Sent" : "Received";
  directionEl.append(
    cloneSvg(message.direction === "sent" ? ICON_ARROW_SENT : ICON_ARROW_RECEIVED),
  );
  container.append(directionEl);

  // Type badge - fixed width
  const typeBadge = document.createElement("div");
  typeBadge.className = `devtools-type-badge ${typeColor}`;
  typeBadge.textContent = typeLabel;
  container.append(typeBadge);

  // ACK indicator with round-trip latency
  const ackBadge = createAckBadge(message);
  if (ackBadge) container.append(ackBadge);

  // Document name - flexible
  const descriptionEl = document.createElement("div");
  descriptionEl.className = "devtools-message-doc";
  if (message.document) {
    descriptionEl.textContent = message.document;
  }
  container.append(descriptionEl);

  // Size in bytes
  const sizeEl = document.createElement("div");
  sizeEl.className = "devtools-message-size";
  sizeEl.textContent = `${message.message.encoded.byteLength}`;
  container.append(sizeEl);

  // Timestamp
  const timestampEl = document.createElement("div");
  timestampEl.className = "devtools-message-time";
  timestampEl.textContent = formatTimestamp(message.timestamp);
  container.append(timestampEl);

  item.append(container);
  return item;
}
