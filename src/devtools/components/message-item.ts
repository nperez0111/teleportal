import type { DevtoolsMessage } from "../types";
import {
  getMessageTypeLabel,
  getMessageTypeColor,
  formatTimestamp,
} from "../utils/message-utils";

export function createMessageItem(
  message: DevtoolsMessage,
  isSelected: boolean,
  onClick: () => void,
): HTMLElement {
  const item = document.createElement("div");
  item.className = `devtools-px-2 devtools-py-1.5 devtools-border-b devtools-border-gray-200 devtools-cursor-pointer devtools-hover:bg-gray-50 devtools-transition-colors devtools-text-xs ${
    isSelected
      ? "devtools-bg-blue-50 devtools-border-l-2 devtools-border-l-blue-500"
      : ""
  }`;
  item.addEventListener("click", onClick);

  const typeLabel = getMessageTypeLabel(message.message);
  const typeColor = getMessageTypeColor(message.message);

  const container = document.createElement("div");
  container.className = "devtools-message-row";

  // Direction icon
  const directionEl = document.createElement("div");
  directionEl.className = `devtools-direction-icon ${message.direction === "sent" ? "devtools-direction-sent" : "devtools-direction-received"}`;
  directionEl.title = message.direction === "sent" ? "Sent" : "Received";
  directionEl.innerHTML =
    message.direction === "sent"
      ? `<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2.5 9.5L9.5 2.5M9.5 2.5H4.5M9.5 2.5V7.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      : `<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M9.5 2.5L2.5 9.5M2.5 9.5H7.5M2.5 9.5V4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  container.appendChild(directionEl);

  // Type badge - fixed width
  const typeBadge = document.createElement("div");
  typeBadge.className = `devtools-type-badge ${typeColor}`;
  typeBadge.textContent = typeLabel;
  container.appendChild(typeBadge);

  // ACK indicator
  if (message.ackedBy) {
    const ackIndicator = document.createElement("span");
    ackIndicator.className = "devtools-ack-indicator";
    ackIndicator.textContent = "✓";
    ackIndicator.title = "ACK'd";
    container.appendChild(ackIndicator);
  }

  // Document name - flexible
  const descriptionEl = document.createElement("div");
  descriptionEl.className = "devtools-message-doc";
  if (message.document) {
    descriptionEl.textContent = message.document;
  }
  container.appendChild(descriptionEl);

  // Timestamp
  const timestampEl = document.createElement("div");
  timestampEl.className = "devtools-message-time";
  timestampEl.textContent = formatTimestamp(message.timestamp);
  container.appendChild(timestampEl);

  item.appendChild(container);
  return item;
}
