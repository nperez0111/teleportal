export const panelStyles = `
  :root {
    --tp-bg: #ffffff;
    --tp-bg-secondary: #f8fafc;
    --tp-bg-tertiary: #f1f5f9;
    --tp-border: #e2e8f0;
    --tp-text: #1e293b;
    --tp-text-secondary: #64748b;
    --tp-text-muted: #94a3b8;
    --tp-primary: #3b82f6;
    --tp-primary-hover: #2563eb;
    --tp-success: #10b981;
    --tp-warning: #f59e0b;
    --tp-error: #ef4444;
    --tp-sent-bg: #eff6ff;
    --tp-sent-border: #bfdbfe;
    --tp-sent-text: #1e40af;
    --tp-received-bg: #f0fdf4;
    --tp-received-border: #bbf7d0;
    --tp-received-text: #166534;
    --tp-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
    --tp-shadow-lg: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);
    --tp-radius: 8px;
    --tp-radius-sm: 4px;
  }

  @media (prefers-color-scheme: dark), .tp-theme-dark {
    .tp-panel {
      --tp-bg: #0f172a;
      --tp-bg-secondary: #1e293b;
      --tp-bg-tertiary: #334155;
      --tp-border: #334155;
      --tp-text: #f1f5f9;
      --tp-text-secondary: #94a3b8;
      --tp-text-muted: #64748b;
      --tp-primary: #60a5fa;
      --tp-primary-hover: #3b82f6;
      --tp-sent-bg: #1e3a5f;
      --tp-sent-border: #1e40af;
      --tp-sent-text: #bfdbfe;
      --tp-received-bg: #14532d;
      --tp-received-border: #166534;
      --tp-received-text: #bbf7d0;
    }
  }

  .tp-panel {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    font-size: 13px;
    color: var(--tp-text);
    background: var(--tp-bg);
    border-radius: var(--tp-radius);
    box-shadow: var(--tp-shadow-lg);
    overflow: hidden;
    height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: row;
  }

  .tp-panel-left {
    flex: 1;
    min-width: 320px;
    max-width: 420px;
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--tp-border);
    overflow: hidden;
    min-height: 0;
  }

  .tp-panel-right {
    flex: 1;
    min-width: 400px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .tp-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    background: var(--tp-bg-secondary);
    border-bottom: 1px solid var(--tp-border);
    flex-shrink: 0;
  }

  .tp-logo {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
    font-size: 14px;
  }

  .tp-logo-icon {
    width: 20px;
    height: 20px;
    background: linear-gradient(135deg, var(--tp-primary), #8b5cf6);
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: white;
    font-size: 10px;
    font-weight: 700;
  }

  .tp-header-actions {
    display: flex;
    gap: 4px;
  }

  .tp-btn {
    padding: 6px 10px;
    border: none;
    background: transparent;
    color: var(--tp-text-secondary);
    cursor: pointer;
    border-radius: var(--tp-radius-sm);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s ease;
  }

  .tp-btn:hover {
    background: var(--tp-bg-tertiary);
    color: var(--tp-text);
  }

  .tp-btn-icon {
    padding: 6px;
  }

  .tp-btn-small {
    padding: 4px;
  }

  .tp-btn-link {
    background: none;
    border: none;
    color: var(--tp-primary);
    cursor: pointer;
    font-size: 11px;
    padding: 0;
  }

  .tp-btn-link:hover {
    text-decoration: underline;
  }

  .tp-toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    background: var(--tp-bg);
    border-bottom: 1px solid var(--tp-border);
    flex-shrink: 0;
  }

  .tp-search {
    flex: 1;
    position: relative;
  }

  .tp-search-icon {
    position: absolute;
    left: 10px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--tp-text-muted);
    pointer-events: none;
  }

  .tp-search input {
    width: 100%;
    padding: 6px 10px 6px 32px;
    border: 1px solid var(--tp-border);
    border-radius: var(--tp-radius-sm);
    background: var(--tp-bg);
    color: var(--tp-text);
    font-size: 12px;
    outline: none;
    transition: border-color 0.15s ease;
  }

  .tp-search input:focus {
    border-color: var(--tp-primary);
  }

  .tp-search input::placeholder {
    color: var(--tp-text-muted);
  }

  .tp-filter-group {
    display: flex;
    background: var(--tp-bg-tertiary);
    border-radius: var(--tp-radius-sm);
    padding: 2px;
  }

  .tp-filter-btn {
    padding: 4px 10px;
    border: none;
    background: transparent;
    color: var(--tp-text-secondary);
    cursor: pointer;
    font-size: 11px;
    font-weight: 500;
    border-radius: 3px;
    transition: all 0.15s ease;
  }

  .tp-filter-btn:hover {
    color: var(--tp-text);
  }

  .tp-filter-btn.active {
    background: var(--tp-bg);
    color: var(--tp-text);
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.05);
  }

  .tp-type-filters {
    padding: 8px 14px;
    border-bottom: 1px solid var(--tp-border);
    flex-shrink: 0;
  }

  .tp-type-filters-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--tp-text-secondary);
  }

  .tp-type-filters-list {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .tp-type-filter {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--tp-text-secondary);
    cursor: pointer;
    padding: 4px 8px;
    background: var(--tp-bg);
    border: 1px solid var(--tp-border);
    border-radius: var(--tp-radius-sm);
    transition: all 0.15s ease;
  }

  .tp-type-filter:hover {
    background: var(--tp-bg-tertiary);
  }

  .tp-type-filter input {
    display: none;
  }

  .tp-type-filter.active {
    background: var(--tp-primary);
    color: white;
    border-color: var(--tp-primary);
  }

  .tp-type-count {
    font-size: 10px;
    opacity: 0.7;
  }

  .tp-status-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 8px;
    padding: 12px 14px;
    border-bottom: 1px solid var(--tp-border);
    flex-shrink: 0;
  }

  .tp-status-card {
    background: var(--tp-bg);
    border: 1px solid var(--tp-border);
    border-radius: var(--tp-radius);
    padding: 10px;
  }

  .tp-status-card-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--tp-text-muted);
    margin-bottom: 4px;
  }

  .tp-status-card-value {
    font-size: 13px;
    font-weight: 600;
    color: var(--tp-text);
    text-transform: capitalize;
  }

  .tp-status-card-value.synced,
  .tp-status-card-value.connected {
    color: var(--tp-success);
  }

  .tp-status-card-value.syncing,
  .tp-status-card-value.connecting {
    color: var(--tp-warning);
  }

  .tp-status-card-value.disconnected,
  .tp-status-card-value.errored {
    color: var(--tp-error);
  }

  .tp-awareness-section {
    padding: 10px 14px;
    border-bottom: 1px solid var(--tp-border);
    flex: 0 0 auto;
    max-height: 120px;
    overflow-y: auto;
  }

  .tp-awareness-title {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--tp-text-secondary);
    margin-bottom: 8px;
  }

  .tp-awareness-item {
    background: var(--tp-bg);
    border: 1px solid var(--tp-border);
    border-radius: var(--tp-radius-sm);
    margin-bottom: 6px;
    overflow: hidden;
  }

  .tp-awareness-item:last-child {
    margin-bottom: 0;
  }

  .tp-awareness-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    cursor: pointer;
  }

  .tp-awareness-header:hover {
    background: var(--tp-bg-tertiary);
  }

  .tp-awareness-avatar {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: var(--tp-primary);
    color: white;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 9px;
    font-weight: 600;
    flex-shrink: 0;
  }

  .tp-awareness-info {
    flex: 1;
    min-width: 0;
  }

  .tp-awareness-name {
    font-size: 12px;
    font-weight: 500;
    color: var(--tp-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .tp-awareness-id {
    font-size: 10px;
    color: var(--tp-text-muted);
  }

  .tp-awareness-chevron {
    color: var(--tp-text-muted);
    transition: transform 0.2s ease;
    flex-shrink: 0;
  }

  .tp-awareness-item.expanded .tp-awareness-chevron {
    transform: rotate(180deg);
  }

  .tp-awareness-json {
    display: none;
    padding: 10px;
    background: var(--tp-bg-secondary);
    border-top: 1px solid var(--tp-border);
  }

  .tp-awareness-item.expanded .tp-awareness-json {
    display: block;
  }

  .tp-awareness-json pre {
    margin: 0;
    font-size: 10px;
    font-family: monospace;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--tp-text-secondary);
    max-height: 120px;
    overflow-y: auto;
  }

  .tp-milestones-section {
    padding: 10px 14px;
    border-bottom: 1px solid var(--tp-border);
    flex: 0 0 auto;
    max-height: 100px;
    overflow-y: auto;
  }

  .tp-milestones-title {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--tp-text-secondary);
    margin-bottom: 8px;
  }

  .tp-milestone-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 10px;
    background: var(--tp-bg);
    border: 1px solid var(--tp-border);
    border-radius: var(--tp-radius-sm);
    margin-bottom: 4px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .tp-milestone-item:hover {
    border-color: var(--tp-primary);
  }

  .tp-milestone-item.selected {
    border-color: var(--tp-primary);
    background: rgba(59, 130, 246, 0.05);
  }

  .tp-milestone-item:last-child {
    margin-bottom: 0;
  }

  .tp-milestone-info {
    flex: 1;
    min-width: 0;
  }

  .tp-milestone-name {
    font-size: 12px;
    font-weight: 500;
    color: var(--tp-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .tp-milestone-time {
    font-size: 10px;
    color: var(--tp-text-muted);
  }

  .tp-milestone-more {
    font-size: 11px;
    color: var(--tp-text-muted);
    padding: 4px 0;
    text-align: center;
  }

  .tp-messages-section {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    padding: 10px 14px;
    min-height: 0;
  }

  .tp-messages-header {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--tp-text-secondary);
    margin-bottom: 8px;
    flex-shrink: 0;
  }

  .tp-message-list {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-height: 0;
  }

  .tp-message {
    border-radius: var(--tp-radius);
    overflow: hidden;
    cursor: pointer;
    transition: all 0.15s ease;
    flex-shrink: 0;
  }

  .tp-message:hover {
    filter: brightness(0.98);
  }

  .tp-message.selected {
    outline: 2px solid var(--tp-primary);
    outline-offset: -2px;
  }

  .tp-message-header {
    display: flex;
    align-items: center;
    padding: 8px 10px;
    gap: 8px;
  }

  .tp-message.sent .tp-message-header {
    background: var(--tp-sent-bg);
  }

  .tp-message.received .tp-message-header {
    background: var(--tp-received-bg);
  }

  .tp-msg-direction {
    font-size: 11px;
    font-weight: 600;
    width: 16px;
    text-align: center;
    flex-shrink: 0;
  }

  .tp-message.sent .tp-msg-direction {
    color: var(--tp-sent-text);
  }

  .tp-message.received .tp-msg-direction {
    color: var(--tp-received-text);
  }

  .tp-msg-info {
    flex: 1;
    min-width: 0;
  }

  .tp-msg-type {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px;
    font-size: 12px;
    font-weight: 500;
    color: var(--tp-text);
  }

  .tp-msg-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 10px;
    color: var(--tp-text-muted);
    margin-top: 2px;
  }

  .tp-msg-id {
    font-family: monospace;
    opacity: 0.7;
    cursor: pointer;
  }

  .tp-msg-id:hover {
    opacity: 1;
  }

  .tp-msg-time {
    opacity: 0.7;
  }

  .tp-empty {
    text-align: center;
    padding: 32px 16px;
    color: var(--tp-text-muted);
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
  }

  .tp-empty-icon {
    font-size: 36px;
    margin-bottom: 12px;
    opacity: 0.5;
  }

  .tp-empty-hint {
    font-size: 11px;
    margin-top: 4px;
    opacity: 0.7;
  }

  .tp-footer {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 14px;
    background: var(--tp-bg-secondary);
    border-top: 1px solid var(--tp-border);
    font-size: 11px;
    color: var(--tp-text-secondary);
  }

  .tp-footer-stats {
    display: flex;
    gap: 16px;
  }

  .tp-stat {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .tp-stat-value {
    font-weight: 600;
    color: var(--tp-text);
  }

  .tp-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    background: var(--tp-bg-tertiary);
    border-radius: 9px;
    font-size: 10px;
    font-weight: 600;
    color: var(--tp-text);
  }

  .tp-encrypted-badge,
  .tp-acked-badge {
    font-size: 9px;
    padding: 2px 4px;
    border-radius: 3px;
    font-weight: 600;
  }

  .tp-encrypted-badge {
    background: rgba(139, 92, 246, 0.1);
    color: #8b5cf6;
  }

  .tp-acked-badge {
    background: rgba(16, 185, 129, 0.1);
    color: #10b981;
  }

  .tp-detail-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    background: var(--tp-bg-secondary);
    border-bottom: 1px solid var(--tp-border);
    flex-shrink: 0;
  }

  .tp-detail-title {
    font-weight: 600;
    font-size: 14px;
  }

  .tp-detail-actions {
    display: flex;
    gap: 4px;
  }

  .tp-detail-content {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    min-height: 0;
  }

  .tp-detail-meta {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-bottom: 20px;
  }

  .tp-detail-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
  }

  .tp-detail-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--tp-text-muted);
    width: 80px;
    flex-shrink: 0;
    padding-top: 2px;
  }

  .tp-detail-value {
    flex: 1;
    font-size: 13px;
    color: var(--tp-text);
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .tp-detail-value.sent {
    color: var(--tp-sent-text);
  }

  .tp-detail-value.received {
    color: var(--tp-received-text);
  }

  .tp-detail-value.mono {
    font-family: monospace;
    word-break: break-all;
  }

  .tp-detail-payload {
    margin-top: 16px;
  }

  .tp-detail-section-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--tp-text-secondary);
    margin-bottom: 8px;
  }

  .tp-detail-payload pre {
    margin: 0;
    padding: 12px;
    background: var(--tp-bg);
    border: 1px solid var(--tp-border);
    border-radius: var(--tp-radius-sm);
    font-size: 11px;
    font-family: monospace;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 300px;
  }

  .tp-detail-empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: var(--tp-text-muted);
    padding: 32px;
    text-align: center;
  }

  .tp-detail-empty-icon {
    font-size: 48px;
    margin-bottom: 16px;
    opacity: 0.4;
  }

  .tp-detail-empty-text {
    font-size: 14px;
    font-weight: 500;
    color: var(--tp-text-secondary);
    margin-bottom: 8px;
  }

  .tp-detail-empty-hint {
    font-size: 12px;
    opacity: 0.7;
  }
`;
