/**
 * CSS styles for the devtool panel
 * Uses Bootstrap CDN for base styles, adds custom styles for devtool-specific components
 */
export const devtoolStyles = `
/* Bootstrap CDN will be loaded separately */
/* Custom devtool styles */

.tp-devtool {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 14px;
  line-height: 1.5;
  color: var(--tp-text-color, #333);
  background: var(--tp-bg-color, #fff);
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* Theme variables */
.tp-devtool[data-theme="dark"],
.tp-devtool.dark {
  --tp-bg-color: #1e1e1e;
  --tp-text-color: #d4d4d4;
  --tp-border-color: #3e3e3e;
  --tp-hover-bg: #2d2d2d;
  --tp-selected-bg: #094771;
  --tp-code-bg: #252526;
  --tp-code-text: #d4d4d4;
}

.tp-devtool[data-theme="light"],
.tp-devtool.light {
  --tp-bg-color: #ffffff;
  --tp-text-color: #333333;
  --tp-border-color: #e0e0e0;
  --tp-hover-bg: #f5f5f5;
  --tp-selected-bg: #e3f2fd;
  --tp-code-bg: #f5f5f5;
  --tp-code-text: #333333;
}

/* Header */
.tp-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--tp-border-color);
  background: var(--tp-bg-color);
  flex-shrink: 0;
}

.tp-logo {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  font-size: 16px;
}

.tp-logo-icon {
  width: 32px;
  height: 32px;
  border-radius: 4px;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: bold;
  font-size: 14px;
}

.tp-header-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

/* Toolbar */
.tp-toolbar {
  padding: 12px 16px;
  border-bottom: 1px solid var(--tp-border-color);
  background: var(--tp-bg-color);
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
  flex-shrink: 0;
}

.tp-search {
  flex: 1;
  min-width: 200px;
  max-width: 400px;
}

.tp-filter-group {
  display: flex;
  gap: 8px;
  align-items: center;
}

.tp-filter-btn {
  padding: 6px 12px;
  border: 1px solid var(--tp-border-color);
  background: var(--tp-bg-color);
  color: var(--tp-text-color);
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  transition: all 0.2s;
}

.tp-filter-btn:hover {
  background: var(--tp-hover-bg);
}

.tp-filter-btn.active {
  background: var(--tp-selected-bg);
  border-color: var(--tp-selected-bg);
  color: var(--tp-text-color);
}

/* Main content area */
.tp-content {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.tp-sidebar {
  width: 400px;
  min-width: 300px;
  border-right: 1px solid var(--tp-border-color);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--tp-bg-color);
}

.tp-detail-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--tp-bg-color);
}

/* Stats cards */
.tp-stats {
  padding: 16px;
  border-bottom: 1px solid var(--tp-border-color);
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 12px;
}

.tp-stat-card {
  padding: 12px;
  background: var(--tp-hover-bg);
  border-radius: 4px;
  border: 1px solid var(--tp-border-color);
}

.tp-stat-label {
  font-size: 12px;
  color: var(--tp-text-color);
  opacity: 0.7;
  margin-bottom: 4px;
}

.tp-stat-value {
  font-size: 20px;
  font-weight: 600;
  color: var(--tp-text-color);
}

/* Message list */
.tp-message-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.tp-message-item {
  padding: 10px 12px;
  margin-bottom: 4px;
  border: 1px solid var(--tp-border-color);
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s;
  background: var(--tp-bg-color);
}

.tp-message-item:hover {
  background: var(--tp-hover-bg);
}

.tp-message-item.selected {
  background: var(--tp-selected-bg);
  border-color: var(--tp-selected-bg);
}

.tp-message-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.tp-message-icon {
  font-size: 16px;
}

.tp-message-type {
  font-weight: 600;
  font-size: 13px;
  color: var(--tp-text-color);
}

.tp-message-direction {
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
}

.tp-message-direction.sent {
  background: #4caf50;
  color: white;
}

.tp-message-direction.received {
  background: #2196f3;
  color: white;
}

.tp-message-meta {
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: var(--tp-text-color);
  opacity: 0.7;
  margin-top: 4px;
}

/* Detail panel */
.tp-detail-header {
  padding: 16px;
  border-bottom: 1px solid var(--tp-border-color);
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.tp-detail-content {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

.tp-detail-section {
  margin-bottom: 24px;
}

.tp-detail-section-title {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 12px;
  color: var(--tp-text-color);
}

.tp-detail-field {
  margin-bottom: 12px;
}

.tp-detail-field-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--tp-text-color);
  opacity: 0.7;
  margin-bottom: 4px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.tp-detail-field-value {
  font-size: 14px;
  color: var(--tp-text-color);
  word-break: break-all;
}

.tp-code-block {
  background: var(--tp-code-bg);
  color: var(--tp-code-text);
  padding: 12px;
  border-radius: 4px;
  font-family: "Courier New", monospace;
  font-size: 12px;
  overflow-x: auto;
  border: 1px solid var(--tp-border-color);
}

.tp-snapshot-comparison {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin-top: 12px;
}

.tp-snapshot-panel {
  border: 1px solid var(--tp-border-color);
  border-radius: 4px;
  overflow: hidden;
}

.tp-snapshot-header {
  padding: 8px 12px;
  background: var(--tp-hover-bg);
  border-bottom: 1px solid var(--tp-border-color);
  font-weight: 600;
  font-size: 13px;
}

.tp-snapshot-content {
  padding: 12px;
  max-height: 400px;
  overflow-y: auto;
}

/* Peer list */
.tp-peer-list {
  padding: 8px;
  overflow-y: auto;
}

.tp-peer-item {
  padding: 12px;
  margin-bottom: 8px;
  border: 1px solid var(--tp-border-color);
  border-radius: 4px;
  background: var(--tp-bg-color);
}

.tp-peer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.tp-peer-id {
  font-weight: 600;
  font-size: 14px;
}

.tp-peer-docs {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  margin-top: 8px;
}

.tp-peer-doc-tag {
  padding: 2px 6px;
  background: var(--tp-hover-bg);
  border-radius: 3px;
  font-size: 11px;
}

.tp-peer-awareness {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--tp-border-color);
}

/* Empty state */
.tp-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px;
  text-align: center;
  color: var(--tp-text-color);
  opacity: 0.5;
}

.tp-empty-icon {
  font-size: 48px;
  margin-bottom: 16px;
}

/* Scrollbar styling */
.tp-message-list::-webkit-scrollbar,
.tp-detail-content::-webkit-scrollbar,
.tp-peer-list::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

.tp-message-list::-webkit-scrollbar-track,
.tp-detail-content::-webkit-scrollbar-track,
.tp-peer-list::-webkit-scrollbar-track {
  background: var(--tp-bg-color);
}

.tp-message-list::-webkit-scrollbar-thumb,
.tp-detail-content::-webkit-scrollbar-thumb,
.tp-peer-list::-webkit-scrollbar-thumb {
  background: var(--tp-border-color);
  border-radius: 4px;
}

.tp-message-list::-webkit-scrollbar-thumb:hover,
.tp-detail-content::-webkit-scrollbar-thumb:hover,
.tp-peer-list::-webkit-scrollbar-thumb:hover {
  background: var(--tp-hover-bg);
}

/* Responsive */
@media (max-width: 768px) {
  .tp-content {
    flex-direction: column;
  }

  .tp-sidebar {
    width: 100%;
    max-height: 50%;
  }

  .tp-snapshot-comparison {
    grid-template-columns: 1fr;
  }
}
`;

/**
 * Get Bootstrap CDN link tag
 */
export function getBootstrapCDNLink(): string {
  return `<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet" crossorigin="anonymous">`;
}
