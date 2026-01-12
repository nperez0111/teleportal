import type {
  ConnectionState,
  DevtoolStats,
  FilterConfig,
  MessageEntry,
  MessageTypeConfig,
  PanelState,
  PeerState,
  SnapshotData,
  SyncState,
  Theme,
} from "../types.js";
import {
  formatBytes,
  formatMessagePayload,
  formatRelativeTime,
  formatTime,
  getMessageDisplayInfo,
  getMessageTypeKey,
  getPeersForDocument,
  truncateDocId,
  uint8ArrayToHex,
} from "../utils.js";

/**
 * Render the complete devtool panel
 */
export function renderPanel(
  state: PanelState,
  messages: MessageEntry[],
  stats: DevtoolStats,
  connectionState: ConnectionState | null,
  syncStates: Map<string, SyncState>,
  peers: Map<number, PeerState>,
  selectedMessage: MessageEntry | null,
  snapshot: SnapshotData | undefined,
  messageTypes: MessageTypeConfig[],
): string {
  return `
    <div class="tp-devtool" data-theme="${state.theme}">
      ${renderHeader(state.theme, stats)}
      ${renderToolbar(state.filters, messageTypes)}
      <div class="tp-content">
        <div class="tp-sidebar">
          ${renderStats(stats, connectionState, syncStates)}
          ${renderMessageList(messages, state.selectedMessageId, messageTypes)}
        </div>
        <div class="tp-detail-panel">
          ${selectedMessage
            ? renderMessageDetail(selectedMessage, snapshot, messageTypes)
            : renderEmptyDetail()}
        </div>
      </div>
    </div>
  `;
}

/**
 * Render the header
 */
export function renderHeader(theme: Theme, stats: DevtoolStats): string {
  return `
    <div class="tp-header">
      <div class="tp-logo">
        <div class="tp-logo-icon">TP</div>
        <span>Teleportal DevTools</span>
      </div>
      <div class="tp-header-actions">
        <button class="tp-filter-btn" id="tp-theme-toggle" data-theme="${theme}">
          ${theme === "dark" ? "☀️" : "🌙"}
        </button>
        <button class="tp-filter-btn" id="tp-clear-logs">Clear</button>
        <button class="tp-filter-btn" id="tp-export-logs">Export</button>
      </div>
    </div>
  `;
}

/**
 * Render the toolbar with filters
 */
export function renderToolbar(
  filters: FilterConfig,
  messageTypes: MessageTypeConfig[],
): string {
  const documentIds = Array.from(filters.documentIds);
  const selectedTypes = Array.from(filters.messageTypes);

  return `
    <div class="tp-toolbar">
      <input
        type="text"
        class="form-control tp-search"
        id="tp-search-input"
        placeholder="Search messages..."
        value="${escapeHtml(filters.search)}"
      />
      <div class="tp-filter-group">
        <button
          class="tp-filter-btn ${filters.direction === "all" ? "active" : ""}"
          data-direction="all"
          data-action="filter-direction"
        >
          All
        </button>
        <button
          class="tp-filter-btn ${filters.direction === "sent" ? "active" : ""}"
          data-direction="sent"
          data-action="filter-direction"
        >
          Sent
        </button>
        <button
          class="tp-filter-btn ${filters.direction === "received" ? "active" : ""}"
          data-direction="received"
          data-action="filter-direction"
        >
          Received
        </button>
      </div>
      <select class="form-select" id="tp-document-filter" style="min-width: 150px;">
        <option value="">All Documents</option>
        ${documentIds.map((id) => `<option value="${escapeHtml(id)}">${truncateDocId(id)}</option>`).join("")}
      </select>
      <select class="form-select" id="tp-type-filter" style="min-width: 150px;">
        <option value="">All Types</option>
        ${messageTypes.map((mt) => {
          const key = `${mt.type}:${mt.payloadType ?? ""}`;
          return `<option value="${escapeHtml(key)}" ${selectedTypes.includes(key) ? "selected" : ""}>${mt.icon} ${mt.label}</option>`;
        }).join("")}
      </select>
    </div>
  `;
}

/**
 * Render statistics cards
 */
export function renderStats(
  stats: DevtoolStats,
  connectionState: ConnectionState | null,
  syncStates: Map<string, SyncState>,
): string {
  const connectionStatus = connectionState
    ? connectionState.type === "connected"
      ? "🟢 Connected"
      : connectionState.type === "connecting"
        ? "🟡 Connecting"
        : connectionState.type === "errored"
          ? "🔴 Error"
          : "⚪ Disconnected"
    : "⚪ Unknown";

  const syncedDocs = Array.from(syncStates.values()).filter((s) => s.synced).length;
  const totalDocs = syncStates.size;

  return `
    <div class="tp-stats">
      <div class="tp-stat-card">
        <div class="tp-stat-label">Messages Sent</div>
        <div class="tp-stat-value">${stats.messagesSent}</div>
      </div>
      <div class="tp-stat-card">
        <div class="tp-stat-label">Messages Received</div>
        <div class="tp-stat-value">${stats.messagesReceived}</div>
      </div>
      <div class="tp-stat-card">
        <div class="tp-stat-label">Bytes Sent</div>
        <div class="tp-stat-value">${formatBytes(stats.bytesSent)}</div>
      </div>
      <div class="tp-stat-card">
        <div class="tp-stat-label">Bytes Received</div>
        <div class="tp-stat-value">${formatBytes(stats.bytesReceived)}</div>
      </div>
      <div class="tp-stat-card">
        <div class="tp-stat-label">Connection</div>
        <div class="tp-stat-value" style="font-size: 14px;">${connectionStatus}</div>
      </div>
      <div class="tp-stat-card">
        <div class="tp-stat-label">Documents</div>
        <div class="tp-stat-value">${totalDocs} (${syncedDocs} synced)</div>
      </div>
      <div class="tp-stat-card">
        <div class="tp-stat-label">Peers</div>
        <div class="tp-stat-value">${stats.peers.size}</div>
      </div>
    </div>
  `;
}

/**
 * Render the message list
 */
export function renderMessageList(
  messages: MessageEntry[],
  selectedMessageId: string | null,
  messageTypes: MessageTypeConfig[],
): string {
  if (messages.length === 0) {
    return `
      <div class="tp-empty">
        <div class="tp-empty-icon">📭</div>
        <div>No messages yet</div>
      </div>
    `;
  }

  return `
    <div class="tp-message-list">
      ${messages.map((entry) => renderMessageItem(entry, selectedMessageId === entry.id, messageTypes)).join("")}
    </div>
  `;
}

/**
 * Render a single message item
 */
export function renderMessageItem(
  entry: MessageEntry,
  isSelected: boolean,
  messageTypes: MessageTypeConfig[],
): string {
  const displayInfo = getMessageDisplayInfo(entry.message, messageTypes);
  const directionClass = entry.direction === "sent" ? "sent" : "received";

  return `
    <div
      class="tp-message-item ${isSelected ? "selected" : ""}"
      data-message-id="${escapeHtml(entry.id)}"
      data-action="select-message"
    >
      <div class="tp-message-header">
        <span class="tp-message-icon">${displayInfo.icon}</span>
        <span class="tp-message-type">${displayInfo.label}</span>
        <span class="tp-message-direction ${directionClass}">${entry.direction}</span>
      </div>
      <div class="tp-message-meta">
        <span>${truncateDocId(entry.documentId ?? "unknown", 15)}</span>
        <span>${formatRelativeTime(entry.timestamp)}</span>
        <span>${formatBytes(entry.size)}</span>
      </div>
    </div>
  `;
}

/**
 * Render message detail panel
 */
export function renderMessageDetail(
  entry: MessageEntry,
  snapshot: SnapshotData | undefined,
  messageTypes: MessageTypeConfig[],
): string {
  const displayInfo = getMessageDisplayInfo(entry.message, messageTypes);

  return `
    <div class="tp-detail-header">
      <h5 style="margin: 0;">Message Details</h5>
      <button class="tp-filter-btn" id="tp-close-detail">✕</button>
    </div>
    <div class="tp-detail-content">
      <div class="tp-detail-section">
        <div class="tp-detail-section-title">Basic Information</div>
        <div class="tp-detail-field">
          <div class="tp-detail-field-label">Message ID</div>
          <div class="tp-detail-field-value">${escapeHtml(entry.id)}</div>
        </div>
        <div class="tp-detail-field">
          <div class="tp-detail-field-label">Type</div>
          <div class="tp-detail-field-value">${displayInfo.icon} ${displayInfo.label}</div>
        </div>
        <div class="tp-detail-field">
          <div class="tp-detail-field-label">Direction</div>
          <div class="tp-detail-field-value">${entry.direction}</div>
        </div>
        <div class="tp-detail-field">
          <div class="tp-detail-field-label">Document ID</div>
          <div class="tp-detail-field-value">${escapeHtml(entry.documentId ?? "unknown")}</div>
        </div>
        <div class="tp-detail-field">
          <div class="tp-detail-field-label">Timestamp</div>
          <div class="tp-detail-field-value">${formatTime(entry.timestamp)} (${formatRelativeTime(entry.timestamp)})</div>
        </div>
        <div class="tp-detail-field">
          <div class="tp-detail-field-label">Size</div>
          <div class="tp-detail-field-value">${formatBytes(entry.size)}</div>
        </div>
      </div>

      <div class="tp-detail-section">
        <div class="tp-detail-section-title">Payload</div>
        <div class="tp-code-block">${escapeHtml(formatMessagePayload(entry.message.payload))}</div>
      </div>

      <div class="tp-detail-section">
        <div class="tp-detail-section-title">Encoded (Hex)</div>
        <div class="tp-code-block">${escapeHtml(uint8ArrayToHex(entry.message.encoded as Uint8Array))}</div>
      </div>

      ${snapshot ? renderSnapshotComparison(snapshot) : ""}
    </div>
  `;
}

/**
 * Render snapshot comparison (before/after)
 */
export function renderSnapshotComparison(snapshot: SnapshotData): string {
  const beforeHex = snapshot.before ? uint8ArrayToHex(snapshot.before) : "No snapshot";
  const afterHex = snapshot.after ? uint8ArrayToHex(snapshot.after) : "No snapshot";

  return `
    <div class="tp-detail-section">
      <div class="tp-detail-section-title">Document Snapshot Comparison</div>
      <div class="tp-snapshot-comparison">
        <div class="tp-snapshot-panel">
          <div class="tp-snapshot-header">Before</div>
          <div class="tp-snapshot-content">
            <div class="tp-code-block">${escapeHtml(beforeHex)}</div>
          </div>
        </div>
        <div class="tp-snapshot-panel">
          <div class="tp-snapshot-header">After</div>
          <div class="tp-snapshot-content">
            <div class="tp-code-block">${escapeHtml(afterHex)}</div>
          </div>
        </div>
      </div>
    </div>
  `;
}

/**
 * Render empty detail panel
 */
export function renderEmptyDetail(): string {
  return `
    <div class="tp-empty">
      <div class="tp-empty-icon">👈</div>
      <div>Select a message to view details</div>
    </div>
  `;
}

/**
 * Render peer list
 */
export function renderPeerList(
  peers: Map<number, PeerState>,
  selectedDocumentId: string | null,
): string {
  const peersArray = selectedDocumentId
    ? getPeersForDocument(peers, selectedDocumentId)
    : Array.from(peers.values());

  if (peersArray.length === 0) {
    return `
      <div class="tp-empty">
        <div class="tp-empty-icon">👥</div>
        <div>No peers connected</div>
      </div>
    `;
  }

  return `
    <div class="tp-peer-list">
      ${peersArray.map((peer) => renderPeerItem(peer)).join("")}
    </div>
  `;
}

/**
 * Render a single peer item
 */
export function renderPeerItem(peer: PeerState): string {
  const documents = Array.from(peer.documents);
  const awarenessStr = JSON.stringify(peer.awareness, null, 2);

  return `
    <div class="tp-peer-item">
      <div class="tp-peer-header">
        <div class="tp-peer-id">Client ID: ${peer.clientId}</div>
        <div style="font-size: 12px; opacity: 0.7;">${formatRelativeTime(peer.lastSeen)}</div>
      </div>
      <div class="tp-peer-docs">
        ${documents.map((docId) => `<span class="tp-peer-doc-tag">${truncateDocId(docId)}</span>`).join("")}
      </div>
      <div class="tp-peer-awareness">
        <div style="font-size: 12px; font-weight: 600; margin-bottom: 4px;">Awareness:</div>
        <div class="tp-code-block" style="font-size: 11px; max-height: 200px; overflow-y: auto;">
          ${escapeHtml(awarenessStr)}
        </div>
      </div>
    </div>
  `;
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text: string): string {
  if (typeof document === "undefined") {
    // Server-side rendering fallback
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
