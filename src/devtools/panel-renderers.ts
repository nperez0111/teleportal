import type { MessageEntry, TeleportalEventClient } from "./event-client.js";
import type {
  ConnectionTimelineEntry,
  MessageTypeConfig,
  Milestone,
} from "./panel-types.js";
import {
  formatRelativeTime,
  formatTime,
  getMessageDisplayInfo,
  getMessageTypeKey,
  formatMessageDetail,
  truncateDocId,
  getThemeIcon,
  getThemeLabel,
} from "./panel-utils.js";

export function renderPanelHeader(
  theme: "system" | "light" | "dark",
  stats: { sent: number; received: number },
): string {
  return `
    <div class="tp-header">
      <div class="tp-logo">
        <div class="tp-logo-icon">TP</div>
        <span>Teleportal DevTools</span>
      </div>
      <div class="tp-header-actions">
        <button class="tp-btn tp-btn-icon" id="tp-toggle-theme" title="Theme: ${getThemeLabel(theme)}">
          ${getThemeIcon(theme)}
        </button>
        <button class="tp-btn tp-btn-icon" id="tp-clear-logs" title="Clear logs">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </div>
    </div>
  `;
}

export function renderToolbar(filters: {
  direction: "all" | "sent" | "received";
  search: string;
}): string {
  return `
    <div class="tp-toolbar">
      <div class="tp-search">
        <svg class="tp-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
        <input type="text" id="tp-search-input" placeholder="Search messages..." value="${filters.search}">
      </div>
      <div class="tp-filter-group">
        <button class="tp-filter-btn ${filters.direction === "all" ? "active" : ""}" data-direction="all">All</button>
        <button class="tp-filter-btn ${filters.direction === "sent" ? "active" : ""}" data-direction="sent">Sent</button>
        <button class="tp-filter-btn ${filters.direction === "received" ? "active" : ""}" data-direction="received">Received</button>
      </div>
    </div>
  `;
}

export function renderTypeFilters(
  typeConfigs: MessageTypeConfig[],
  activeTypes: Set<string>,
  typeCounts: Map<string, number>,
): string {
  const typesHtml = typeConfigs
    .map((t) => {
      const key = `${t.type}:${t.payloadType || ""}`;
      const isActive = activeTypes.has(key);
      const count = typeCounts.get(key) || 0;
      return `
        <label class="tp-type-filter ${isActive ? "active" : ""}" data-type="${key}">
          <input type="checkbox" ${isActive ? "checked" : ""}>
          <span>${t.icon} ${t.label}</span>
          ${count > 0 ? `<span class="tp-type-count">${count}</span>` : ""}
        </label>
      `;
    })
    .join("");

  return `
    <div class="tp-type-filters">
      <div class="tp-type-filters-header">
        <span>Types</span>
        <button class="tp-btn tp-btn-link" id="tp-clear-types">Clear</button>
      </div>
      <div class="tp-type-filters-list">
        ${typesHtml}
      </div>
    </div>
  `;
}

export function renderStatusCards(
  connectionState: { state: string; transport: string | null },
  syncState: { documentId: string; synced: boolean } | null,
  peerCount: number,
): string {
  return `
    <div class="tp-status-grid">
      <div class="tp-status-card">
        <div class="tp-status-card-label">Connection</div>
        <div class="tp-status-card-value ${connectionState.state}">${connectionState.state}</div>
      </div>
      <div class="tp-status-card">
        <div class="tp-status-card-label">Sync</div>
        <div class="tp-status-card-value ${syncState?.synced ? "synced" : "syncing"}">
          ${syncState ? (syncState.synced ? "Synced" : "Syncing...") : "—"}
        </div>
      </div>
      <div class="tp-status-card">
        <div class="tp-status-card-label">Document</div>
        <div class="tp-status-card-value" style="font-size: 12px; font-weight: 500;">
          ${syncState?.documentId ? truncateDocId(syncState.documentId) : "—"}
        </div>
      </div>
      <div class="tp-status-card">
        <div class="tp-status-card-label">Peers</div>
        <div class="tp-status-card-value">${peerCount}</div>
      </div>
    </div>
  `;
}

export function renderAwarenessSection(
  peers: Map<number, Record<string, unknown>> | null | undefined,
  expandedItems: Set<string>,
): string {
  if (!peers || !(peers instanceof Map) || peers.size === 0) return "";

  const peerArray = Array.from(peers.entries());
  const peerList = peerArray
    .map(([clientId, state]) => {
      const userState = state.user as Record<string, unknown> | undefined;
      const name =
        (userState?.name as string | undefined) ||
        (userState?.color as string | undefined) ||
        `Peer ${clientId}`;
      const initials = name.slice(0, 2).toUpperCase();
      const stateJson = JSON.stringify(state, null, 2);
      const isExpanded = expandedItems.has(String(clientId));

      return `
        <div class="tp-awareness-item ${isExpanded ? "expanded" : ""}" data-client-id="${clientId}">
          <div class="tp-awareness-header">
            <div class="tp-awareness-avatar">${initials}</div>
            <div class="tp-awareness-info">
              <div class="tp-awareness-name">${name}</div>
              <div class="tp-awareness-id">Client ${clientId}</div>
            </div>
            <svg class="tp-awareness-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
          </div>
          <div class="tp-awareness-json">
            <pre>${stateJson}</pre>
          </div>
        </div>
      `;
    })
    .join("");

  return `
    <div class="tp-awareness-section">
      <div class="tp-awareness-title">Awareness States</div>
      ${peerList}
    </div>
  `;
}

export function renderMilestonesSection(
  milestones: Milestone[],
  selectedMilestoneId: string | null,
): string {
  if (milestones.length === 0) return "";

  const milestoneList = milestones
    .slice(0, 10)
    .map((m) => {
      const date = new Date(m.timestamp);
      const time = date.toLocaleTimeString("en-US", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
      });
      return `
        <div class="tp-milestone-item ${selectedMilestoneId === m.id ? "selected" : ""}" data-milestone-id="${m.id}">
          <div class="tp-milestone-info">
            <div class="tp-milestone-name">${m.name}</div>
            <div class="tp-milestone-time">${time}</div>
          </div>
          <button class="tp-btn tp-btn-icon tp-btn-small" title="Restore">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
          </button>
        </div>
      `;
    })
    .join("");

  const more =
    milestones.length > 10
      ? `<div class="tp-milestone-more">+${milestones.length - 10} more</div>`
      : "";

  return `
    <div class="tp-milestones-section">
      <div class="tp-milestones-title">Milestones</div>
      ${milestoneList}
      ${more}
    </div>
  `;
}

export function renderMessagesSection(
  messages: MessageEntry[],
  selectedMessageId: string | null,
  ackedMessages: Set<string>,
): string {
  const messagesHtml =
    messages.length > 0
      ? messages
          .map((entry) =>
            renderMessageItem(entry, selectedMessageId, ackedMessages),
          )
          .join("")
      : `
      <div class="tp-empty">
        <div class="tp-empty-icon">📭</div>
        <div>No messages yet</div>
        <div class="tp-empty-hint">Messages will appear here when sent or received</div>
      </div>
    `;

  return `
    <div class="tp-messages-section">
      <div class="tp-messages-header">
        <span>Messages</span>
        <span class="tp-badge">${messages.length}</span>
      </div>
      <div class="tp-message-list">
        ${messagesHtml}
      </div>
    </div>
  `;
}

export function renderMessageItem(
  entry: MessageEntry,
  selectedMessageId: string | null,
  ackedMessages: Set<string>,
): string {
  const isSelected = selectedMessageId === entry.message.id;
  const payloadInfo = getMessageDisplayInfo(entry.message);
  const isAcked = ackedMessages.has(entry.message.id);
  const showAckIndicator = entry.direction === "sent" && isAcked;
  const relativeTime = formatRelativeTime(entry.timestamp);

  return `
    <div class="tp-message ${entry.direction} ${isSelected ? "selected" : ""}" data-id="${entry.message.id}">
      <div class="tp-message-header">
        <div class="tp-msg-direction">
          ${entry.direction === "sent" ? "→" : "←"}
        </div>
        <div class="tp-msg-info">
          <div class="tp-msg-type">
            ${payloadInfo.icon}
            ${payloadInfo.label}
            ${entry.message.encrypted ? '<span class="tp-encrypted-badge">E2EE</span>' : ""}
            ${showAckIndicator ? '<span class="tp-acked-badge">✓</span>' : ""}
          </div>
          <div class="tp-msg-meta">
            <span class="tp-msg-id" title="Click to copy">${entry.message.id.slice(0, 8)}...</span>
            <span class="tp-msg-time" title="${formatTime(entry.timestamp)}">${relativeTime}</span>
          </div>
        </div>
      </div>
    </div>
  `;
}

export function renderFooter(stats: {
  sent: number;
  received: number;
}): string {
  return `
    <div class="tp-footer">
      <div class="tp-footer-stats">
        <div class="tp-stat">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--tp-primary);"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>
          <span class="tp-stat-value">${stats.sent}</span> sent
        </div>
        <div class="tp-stat">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--tp-success);"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>
          <span class="tp-stat-value">${stats.received}</span> received
        </div>
      </div>
      <div class="tp-stat">
        Teleportal v0.0.1
      </div>
    </div>
  `;
}

export function renderDetailPanel(
  entry: MessageEntry,
  ackedMessages: Set<string>,
): string {
  const payloadInfo = getMessageDisplayInfo(entry.message);
  const isAcked = ackedMessages.has(entry.message.id);
  const showAckIndicator = entry.direction === "sent" && isAcked;

  return `
    <div class="tp-detail-header">
      <div class="tp-detail-title">Message Details</div>
      <div class="tp-detail-actions">
        <button class="tp-btn tp-btn-icon" id="tp-copy-message" title="Copy message">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>
        <button class="tp-btn tp-btn-icon" id="tp-close-detail" title="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
    </div>
    <div class="tp-detail-content">
      <div class="tp-detail-meta">
        <div class="tp-detail-row">
          <span class="tp-detail-label">Direction</span>
          <span class="tp-detail-value ${entry.direction}">${entry.direction === "sent" ? "→ Sent" : "← Received"}</span>
        </div>
        <div class="tp-detail-row">
          <span class="tp-detail-label">Type</span>
          <span class="tp-detail-value">
            ${payloadInfo.icon} ${payloadInfo.label}
            ${entry.message.encrypted ? '<span class="tp-encrypted-badge">E2EE</span>' : ""}
            ${showAckIndicator ? '<span class="tp-acked-badge">✓ Acked</span>' : ""}
          </span>
        </div>
        <div class="tp-detail-row">
          <span class="tp-detail-label">Message ID</span>
          <span class="tp-detail-value mono" id="tp-message-id">${entry.message.id}</span>
          <button class="tp-btn tp-btn-icon tp-btn-small" id="tp-copy-id" title="Copy ID">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          </button>
        </div>
        <div class="tp-detail-row">
          <span class="tp-detail-label">Timestamp</span>
          <span class="tp-detail-value">${formatTime(entry.timestamp)}</span>
        </div>
        ${
          entry.message.document
            ? `
        <div class="tp-detail-row">
          <span class="tp-detail-label">Document</span>
          <span class="tp-detail-value mono">${entry.message.document}</span>
        </div>
        `
            : ""
        }
        ${
          entry.message.context
            ? `
        <div class="tp-detail-row">
          <span class="tp-detail-label">Context</span>
          <span class="tp-detail-value mono">${JSON.stringify(entry.message.context, null, 2)}</span>
        </div>
        `
            : ""
        }
      </div>
      <div class="tp-detail-payload">
        <div class="tp-detail-section-title">Payload</div>
        <pre id="tp-message-payload">${formatMessageDetail(entry.message)}</pre>
      </div>
    </div>
  `;
}

export function renderDetailEmpty(): string {
  return `
    <div class="tp-detail-empty">
      <div class="tp-detail-empty-icon">📝</div>
      <div class="tp-detail-empty-text">Select a message to view details</div>
      <div class="tp-detail-empty-hint">Click on any message in the list to see its full details</div>
    </div>
  `;
}
