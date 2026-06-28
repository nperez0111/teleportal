import type { DevtoolsMessage } from "../types";
import { getMessageTypeLabel, getMessageTypeColor, formatTimestamp } from "../utils/message-utils";
import { cloneSvg, ICON_ARROW_SENT, ICON_ARROW_RECEIVED } from "../utils/svg-cache";

export function createMessageItem(
  message: DevtoolsMessage,
  isSelected: boolean,
  onClick: () => void,
): HTMLElement {
  const item = document.createElement("div");
  item.className = `devtools-px-2 devtools-py-1.5 devtools-border-b devtools-border-gray-200 devtools-cursor-pointer devtools-hover:bg-gray-50 devtools-transition-colors devtools-text-xs ${
    isSelected ? "devtools-bg-blue-50" : ""
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
  directionEl.append(
    cloneSvg(message.direction === "sent" ? ICON_ARROW_SENT : ICON_ARROW_RECEIVED),
  );
  container.append(directionEl);

  // Type badge - fixed width
  const typeBadge = document.createElement("div");
  typeBadge.className = `devtools-type-badge ${typeColor}`;
  typeBadge.textContent = typeLabel;
  container.append(typeBadge);

  // ACK indicator
  if (message.ackedBy) {
    const ackIndicator = document.createElement("span");
    ackIndicator.className = "devtools-ack-indicator";
    ackIndicator.textContent = "✓";
    ackIndicator.title = "ACK'd";
    container.append(ackIndicator);
  }

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
