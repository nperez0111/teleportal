export const devtoolsStyles = `
/* ============================================
   Teleportal Devtools - Clean & Dense
   ============================================ */

:root {
  /* Light Mode */
  --dt-bg-primary: #ffffff;
  --dt-bg-secondary: #f8fafc;
  --dt-bg-tertiary: #f1f5f9;
  --dt-bg-hover: #f1f5f9;
  --dt-bg-selected: #eff6ff;

  --dt-border: #e2e8f0;
  --dt-border-focus: #3b82f6;
  --dt-border-selected: #3b82f6;

  --dt-text-primary: #1e293b;
  --dt-text-secondary: #475569;
  --dt-text-muted: #94a3b8;

  --dt-success: #22c55e;
  --dt-warning: #f59e0b;
  --dt-error: #ef4444;
  --dt-info: #3b82f6;

  /* Message Types */
  --dt-sync-1: #3b82f6;
  --dt-sync-2: #2563eb;
  --dt-update: #22c55e;
  --dt-sync-done: #16a34a;
  --dt-auth: #ef4444;
  --dt-milestone: #8b5cf6;
  --dt-awareness: #f59e0b;
  --dt-file-upload: #6366f1;
  --dt-file-download: #4f46e5;
  --dt-file-part: #818cf8;
  --dt-ack: #64748b;
  --dt-unknown: #94a3b8;

  --dt-font-sans: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --dt-font-mono: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, monospace;
  --dt-radius: 3px;
}

@media (prefers-color-scheme: dark) {
  :root {
    --dt-bg-primary: #0f172a;
    --dt-bg-secondary: #1e293b;
    --dt-bg-tertiary: #334155;
    --dt-bg-hover: #334155;
    --dt-bg-selected: #1e3a5f;

    --dt-border: #334155;
    --dt-border-focus: #60a5fa;
    --dt-border-selected: #60a5fa;

    --dt-text-primary: #f1f5f9;
    --dt-text-secondary: #cbd5e1;
    --dt-text-muted: #64748b;
  }
}

/* Base */
.devtools-container {
  position: relative;
  height: 100%;
  width: 100%;
  display: flex;
  flex-direction: column;
  background: var(--dt-bg-secondary);
  font-family: var(--dt-font-sans);
  font-size: 12px;
  line-height: 1.4;
  color: var(--dt-text-primary);
  -webkit-font-smoothing: antialiased;
}

.devtools-container *, .devtools-container *::before, .devtools-container *::after {
  box-sizing: border-box;
}

/* Scrollbar */
.devtools-container ::-webkit-scrollbar { width: 6px; height: 6px; }
.devtools-container ::-webkit-scrollbar-track { background: transparent; }
.devtools-container ::-webkit-scrollbar-thumb { background: var(--dt-border); border-radius: 3px; }
.devtools-container ::-webkit-scrollbar-thumb:hover { background: var(--dt-text-muted); }

/* Layout */
.devtools-flex { display: flex; }
.devtools-flex-col { flex-direction: column; }
.devtools-flex-1 { flex: 1 1 0%; }
.devtools-shrink-0 { flex-shrink: 0; }
.devtools-flex-shrink-0 { flex-shrink: 0; }
.devtools-min-w-0 { min-width: 0; }
.devtools-items-center { align-items: center; }
.devtools-justify-between { justify-content: space-between; }
.devtools-justify-center { justify-content: center; }
.devtools-inline-flex { display: inline-flex; }
.devtools-block { display: block; }
.devtools-overflow-hidden { overflow: hidden; }
.devtools-overflow-y-auto { overflow-y: auto; }
.devtools-overflow-x-auto { overflow-x: auto; }
.devtools-h-full { height: 100%; }
.devtools-w-full { width: 100%; }

/* Spacing - Compact */
.devtools-px-1 { padding-left: 4px; padding-right: 4px; }
.devtools-px-2 { padding-left: 6px; padding-right: 6px; }
.devtools-py-0.5 { padding-top: 2px; padding-bottom: 2px; }
.devtools-py-1 { padding-top: 3px; padding-bottom: 3px; }
.devtools-py-1.5 { padding-top: 4px; padding-bottom: 4px; }
.devtools-p-1.5 { padding: 4px; }
.devtools-p-2 { padding: 6px; }
.devtools-p-3 { padding: 8px; }
.devtools-p-4 { padding: 12px; }
.devtools-mt-0.5 { margin-top: 2px; }
.devtools-mb-0.5 { margin-bottom: 2px; }
.devtools-mb-1 { margin-bottom: 4px; }
.devtools-gap-1 { gap: 4px; }
.devtools-gap-1.5 { gap: 8px; }
.devtools-gap-2 { gap: 10px; }
.devtools-gap-3 { gap: 14px; }
.devtools-space-y-0.5 > * + * { margin-top: 2px; }
.devtools-space-y-1 > * + * { margin-top: 4px; }
.devtools-space-y-1.5 > * + * { margin-top: 6px; }
.devtools-space-y-2 > * + * { margin-top: 8px; }

/* Typography */
.devtools-text-xs { font-size: 11px; line-height: 1.4; }
.devtools-text-sm { font-size: 12px; line-height: 1.4; }
.devtools-text-base { font-size: 13px; line-height: 1.4; }
.devtools-text-lg { font-size: 14px; line-height: 1.4; }
.devtools-text-[10px] { font-size: 11px; }
.devtools-font-mono { font-family: var(--dt-font-mono); }
.devtools-font-medium { font-weight: 500; }
.devtools-font-semibold { font-weight: 600; }
.devtools-font-bold { font-weight: 700; }
.devtools-text-center { text-align: center; }
.devtools-text-right { text-align: right; }
.devtools-break-all { word-break: break-all; }
.devtools-whitespace-nowrap { white-space: nowrap; }
.devtools-truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Colors */
.devtools-bg-white { background: var(--dt-bg-primary); }
.devtools-bg-gray-50 { background: var(--dt-bg-secondary); }
.devtools-bg-gray-100 { background: var(--dt-bg-tertiary); }
.devtools-text-gray-400, .devtools-text-gray-500 { color: var(--dt-text-muted); }
.devtools-text-gray-600, .devtools-text-gray-700 { color: var(--dt-text-secondary); }
.devtools-text-gray-900 { color: var(--dt-text-primary); }
.devtools-text-white { color: white; }
.devtools-text-blue-600 { color: var(--dt-info); }
.devtools-text-green-600 { color: var(--dt-success); }
.devtools-text-red-600 { color: var(--dt-error); }

/* Borders */
.devtools-border { border: 1px solid var(--dt-border); }
.devtools-border-b { border-bottom: 1px solid var(--dt-border); }
.devtools-border-r { border-right: 1px solid var(--dt-border); }
.devtools-border-l { border-left: 1px solid var(--dt-border); }
.devtools-border-l-2 { border-left: 2px solid var(--dt-border-selected); }
.devtools-border-gray-200, .devtools-border-gray-300 { border-color: var(--dt-border); }
.devtools-border-blue-500 { border-color: var(--dt-border-selected); }
.devtools-rounded { border-radius: var(--dt-radius); }
.devtools-rounded-lg { border-radius: 4px; }
.devtools-rounded-full { border-radius: 50%; }

/* Sizing */
.devtools-w-1.5 { width: 5px; height: 5px; }
.devtools-w-2 { width: 6px; height: 6px; }
.devtools-w-3 { width: 10px; }
.devtools-w-4 { width: 14px; }
.devtools-w-16 { width: 50px; }
.devtools-w-32 { width: auto; min-width: 70px; } /* Badge - auto width */
.devtools-w-96 { width: 320px; }
.devtools-h-1.5 { height: 5px; }
.devtools-h-2 { height: 6px; }
.devtools-min-w-[60px] { min-width: 50px; }
.devtools-max-h-24 { max-height: 5rem; }
.devtools-max-h-32 { max-height: 6rem; }
.devtools-max-h-48 { max-height: 10rem; }
.devtools-max-h-[60vh] { max-height: 60vh; }

/* Interactive */
.devtools-cursor-pointer { cursor: pointer; }
.devtools-transition-colors { transition: background-color 100ms; }
.devtools-hover:bg-gray-50:hover { background: var(--dt-bg-hover); }
.devtools-hover:bg-gray-200:hover { background: var(--dt-bg-tertiary); }
.devtools-hover:text-gray-900:hover { color: var(--dt-text-primary); }
.devtools-hover:underline:hover { text-decoration: underline; }

/* Message Type Badges - Compact */
.devtools-bg-blue-500 { background: var(--dt-sync-1); }
.devtools-bg-blue-600 { background: var(--dt-sync-2); }
.devtools-bg-green-500 { background: var(--dt-update); }
.devtools-bg-green-600 { background: var(--dt-sync-done); }
.devtools-bg-red-500 { background: var(--dt-auth); }
.devtools-bg-red-600 { background: var(--dt-auth); }
.devtools-bg-purple-500 { background: var(--dt-milestone); }
.devtools-bg-yellow-500 { background: var(--dt-awareness); }
.devtools-bg-yellow-600 { background: var(--dt-awareness); }
.devtools-bg-indigo-400 { background: var(--dt-file-part); }
.devtools-bg-indigo-500 { background: var(--dt-file-upload); }
.devtools-bg-indigo-600 { background: var(--dt-file-download); }
.devtools-bg-gray-400 { background: var(--dt-unknown); }
.devtools-bg-gray-500 { background: var(--dt-ack); }

/* Connection Status */
.devtools-w-2.devtools-h-2.devtools-rounded-full {
  width: 7px;
  height: 7px;
  margin-right: 3px;
}

.devtools-ml-1 { margin-left: 6px; }

/* Form Elements - Compact */
.devtools-input {
  padding: 4px 8px;
  border: 1px solid var(--dt-border);
  border-radius: var(--dt-radius);
  background: var(--dt-bg-primary);
  color: var(--dt-text-primary);
  font-size: 12px;
  font-family: inherit;
}
.devtools-input:focus {
  outline: none;
  border-color: var(--dt-border-focus);
}
.devtools-input::placeholder { color: var(--dt-text-muted); }

.devtools-select {
  padding: 4px 24px 4px 8px;
  border: 1px solid var(--dt-border);
  border-radius: var(--dt-radius);
  background: var(--dt-bg-primary) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 20 20'%3E%3Cpath stroke='%2394a3b8' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.5' d='m6 8 4 4 4-4'/%3E%3C/svg%3E") right 4px center/14px no-repeat;
  color: var(--dt-text-primary);
  font-size: 12px;
  font-family: inherit;
  appearance: none;
  cursor: pointer;
}
.devtools-select:focus {
  outline: none;
  border-color: var(--dt-border-focus);
}
.devtools-transport-select {
  padding: 2px 20px 2px 6px;
  font-size: 11px;
  margin-left: 4px;
  min-width: 0;
  width: auto;
}
.devtools-transport-select:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.devtools-checkbox {
  width: 12px;
  height: 12px;
  margin-right: 4px;
  accent-color: var(--dt-info);
  cursor: pointer;
}

/* Buttons - Simple */
.devtools-button {
  padding: 4px 10px;
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
  border-radius: var(--dt-radius);
  border: none;
  cursor: pointer;
  background: transparent;
  color: var(--dt-text-secondary);
}
.devtools-button:hover {
  background: var(--dt-bg-hover);
  color: var(--dt-text-primary);
}

.devtools-button-primary {
  background: var(--dt-info);
  color: white;
}
.devtools-button-primary:hover {
  background: #2563eb;
}

/* Message List Item - Clean & Spacious */
.devtools-px-2.devtools-py-1.5.devtools-border-b {
  padding: 10px 12px;
  margin: 0;
  border-bottom: 1px solid var(--dt-border);
  background: var(--dt-bg-primary);
  transition: background-color 120ms ease, box-shadow 120ms ease;
}
.devtools-px-2.devtools-py-1.5.devtools-border-b:hover {
  background: var(--dt-bg-hover);
}

/* Selected Item */
.devtools-bg-blue-50 {
  background: var(--dt-bg-selected) !important;
  box-shadow: inset 3px 0 0 var(--dt-border-selected);
}

/* Message Row Layout */
.devtools-message-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

/* Type Badge - Fixed width for alignment */
.devtools-type-badge {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 150px;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  text-align: center;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: white;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ACK Indicator — pill showing the ack round-trip latency */
.devtools-ack-indicator {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 18px;
  padding: 0 6px;
  border-radius: 9px;
  font-size: 10px;
  font-weight: 600;
  font-family: var(--dt-font-mono);
  white-space: nowrap;
}

.devtools-ack-fast {
  color: var(--dt-success);
  background: rgba(34, 197, 94, 0.12);
}

.devtools-ack-slow {
  color: var(--dt-warning);
  background: rgba(245, 158, 11, 0.14);
}

.devtools-ack-stalled {
  color: var(--dt-error);
  background: rgba(239, 68, 68, 0.14);
}

/* Document Name */
.devtools-message-doc {
  flex: 1;
  min-width: 0;
  font-family: var(--dt-font-mono);
  font-size: 11px;
  color: var(--dt-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 2px 0;
}

/* Size */
.devtools-message-size {
  flex-shrink: 0;
  min-width: 50px;
  text-align: right;
  font-size: 10px;
  font-family: var(--dt-font-mono);
  color: var(--dt-text-muted);
  white-space: nowrap;
  opacity: 0.8;
}

/* Timestamp */
.devtools-message-time {
  flex-shrink: 0;
  min-width: 70px;
  text-align: right;
  font-size: 10px;
  font-family: var(--dt-font-mono);
  color: var(--dt-text-muted);
  white-space: nowrap;
  opacity: 0.8;
}

/* Panel Headers - Clean */
.devtools-px-2.devtools-py-1.devtools-border-b.devtools-bg-gray-50 {
  padding: 10px 12px;
  background: var(--dt-bg-secondary);
}

/* Message List Header - matches inspector header */
.devtools-list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  background: var(--dt-bg-secondary);
  border-bottom: 1px solid var(--dt-border);
  min-height: 45px;
  box-sizing: border-box;
}

.devtools-list-header-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--dt-text-primary);
  letter-spacing: 0.02em;
  margin: 0;
}

/* Inspector */
.devtools-p-1.5.devtools-rounded.devtools-space-y-1.5 {
  padding: 6px;
  background: var(--dt-bg-secondary);
  border-radius: var(--dt-radius);
}

pre.devtools-bg-gray-50 {
  padding: 10px;
  background: var(--dt-bg-tertiary);
  border: 1px solid var(--dt-border);
  border-radius: var(--dt-radius);
  font-family: var(--dt-font-mono);
  font-size: 11px;
  line-height: 1.5;
}

/* Filters Panel */
.devtools-bg-gray-50.devtools-border-b {
  background: var(--dt-bg-secondary);
}

/* Filters Button */
.devtools-filters-button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  margin: 2px 0;
  font-size: 11px;
  font-weight: 500;
  font-family: inherit;
  color: var(--dt-text-secondary);
  background: var(--dt-bg-primary);
  border: 1px solid var(--dt-border);
  border-radius: 3px;
  cursor: pointer;
}

.devtools-filters-button:hover {
  background: var(--dt-bg-hover);
  border-color: var(--dt-text-muted);
}

.devtools-filters-arrow {
  font-size: 8px;
  color: var(--dt-text-muted);
}

.devtools-filters-active-indicator {
  width: 6px;
  height: 6px;
  background: var(--dt-success);
  border-radius: 50%;
  margin-left: 2px;
}

.devtools-max-h-24.devtools-overflow-y-auto.devtools-border {
  background: var(--dt-bg-primary);
  border: 1px solid var(--dt-border);
  border-radius: var(--dt-radius);
}

.devtools-hover:bg-gray-50.devtools-px-1.devtools-py-0.5.devtools-rounded {
  padding: 3px 5px;
  border-radius: 2px;
}
.devtools-hover:bg-gray-50.devtools-px-1.devtools-py-0.5.devtools-rounded:hover {
  background: var(--dt-bg-hover);
}

/* Filter Indicator */
.devtools-w-1.5.devtools-h-1.5.devtools-rounded-full.devtools-bg-green-500 {
  width: 5px;
  height: 5px;
  background: var(--dt-success);
}


/* Empty State */
.devtools-p-4.devtools-text-center.devtools-text-xs.devtools-text-gray-500 {
  padding: 40px 16px;
  color: var(--dt-text-muted);
  font-size: 12px;
}

.devtools-h-full.devtools-bg-white.devtools-flex.devtools-items-center.devtools-justify-center {
  background: var(--dt-bg-primary);
}

/* Direction Icons */
.devtools-direction-icon {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 4px;
  transition: background-color 120ms ease;
}

.devtools-direction-icon svg {
  display: block;
}

.devtools-direction-sent {
  color: var(--dt-info);
  background: rgba(59, 130, 246, 0.1);
}

.devtools-direction-received {
  color: var(--dt-success);
  background: rgba(34, 197, 94, 0.1);
}

/* Section Headers */
.devtools-text-xs.devtools-font-semibold.devtools-text-gray-700.devtools-mb-1 {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--dt-text-muted);
  margin-bottom: 6px;
}

/* Metadata Rows */
.devtools-flex.devtools-justify-between {
  padding: 2px 0;
}

/* Focus */
.devtools-container *:focus-visible {
  outline: 1px solid var(--dt-border-focus);
  outline-offset: 1px;
}

/* Selection */
.devtools-container ::selection {
  background: var(--dt-info);
  color: white;
}

@media (prefers-reduced-motion: reduce) {
  .devtools-container * { transition: none !important; }
}

/* ============================================
   Message Inspector - Beautiful Layout
   ============================================ */

.devtools-inspector {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--dt-bg-primary);
}

.devtools-inspector-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  background: var(--dt-bg-secondary);
  border-bottom: 1px solid var(--dt-border);
  min-height: 45px;
  box-sizing: border-box;
}

.devtools-inspector-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--dt-text-primary);
  letter-spacing: 0.02em;
}

.devtools-inspector-btn-group {
  display: flex;
  align-items: center;
  gap: 6px;
}

.devtools-inspector-copy-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  font-size: 11px;
  font-weight: 500;
  font-family: inherit;
  color: white;
  background: var(--dt-info);
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 150ms, transform 100ms;
}

.devtools-inspector-copy-btn:hover {
  background: #2563eb;
}

.devtools-inspector-copy-btn:active {
  transform: scale(0.97);
}

.devtools-inspector-copy-btn.copied {
  background: var(--dt-success);
}

.devtools-inspector-content {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
}

.devtools-inspector-section {
  margin-bottom: 16px;
}

.devtools-inspector-section:last-child {
  margin-bottom: 0;
}

.devtools-inspector-section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--dt-text-muted);
  margin-bottom: 8px;
}

.devtools-inspector-section-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  color: var(--dt-text-muted);
}

.devtools-inspector-card {
  background: var(--dt-bg-secondary);
  border: 1px solid var(--dt-border);
  border-radius: 6px;
  overflow: hidden;
}

.devtools-inspector-row {
  display: flex;
  align-items: flex-start;
  padding: 8px 10px;
  border-bottom: 1px solid var(--dt-border);
}

.devtools-inspector-row:last-child {
  border-bottom: none;
}

.devtools-inspector-row:hover {
  background: var(--dt-bg-tertiary);
}

.devtools-inspector-label {
  flex-shrink: 0;
  width: 80px;
  font-size: 11px;
  font-weight: 500;
  color: var(--dt-text-muted);
}

.devtools-inspector-value {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: var(--dt-text-primary);
  word-break: break-word;
}

.devtools-inspector-value-mono {
  font-family: var(--dt-font-mono);
  font-size: 10px;
}

.devtools-inspector-value-copyable {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}

.devtools-inspector-value-text {
  flex: 1;
  min-width: 0;
  word-break: break-all;
}

.devtools-inspector-copy-icon {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  color: var(--dt-text-muted);
  background: var(--dt-bg-primary);
  border: 1px solid var(--dt-border);
  border-radius: 3px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 150ms, color 150ms, border-color 150ms;
}

.devtools-inspector-row:hover .devtools-inspector-copy-icon {
  opacity: 1;
}

.devtools-inspector-copy-icon:hover {
  color: var(--dt-info);
  border-color: var(--dt-info);
}

.devtools-inspector-copy-icon.copied {
  color: var(--dt-success);
  border-color: var(--dt-success);
}

/* Direction Badge */
.devtools-inspector-direction {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  font-size: 10px;
  font-weight: 500;
  border-radius: 10px;
}

.devtools-inspector-direction-sent {
  color: var(--dt-info);
  background: rgba(59, 130, 246, 0.1);
}

.devtools-inspector-direction-received {
  color: var(--dt-success);
  background: rgba(34, 197, 94, 0.1);
}

.devtools-inspector-direction-icon {
  display: flex;
  align-items: center;
}

/* Type Badge in Inspector */
.devtools-inspector-type {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  font-size: 10px;
  font-weight: 500;
  color: white;
  border-radius: 3px;
}

/* Encrypted Status */
.devtools-inspector-encrypted {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
}

.devtools-inspector-encrypted-yes {
  color: var(--dt-success);
}

.devtools-inspector-encrypted-no {
  color: var(--dt-text-muted);
}

/* ACK Section */
.devtools-inspector-ack-container {
  margin-top: 8px;
  border: 1px solid rgba(34, 197, 94, 0.25);
  border-radius: 6px;
  overflow: hidden;
}

.devtools-inspector-ack-button {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  background: rgba(34, 197, 94, 0.08);
  border: none;
  cursor: pointer;
  font-family: inherit;
  text-align: left;
  transition: background-color 150ms;
}

.devtools-inspector-ack-button:hover {
  background: rgba(34, 197, 94, 0.15);
}

.devtools-inspector-ack-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  color: var(--dt-success);
  background: rgba(34, 197, 94, 0.2);
  border-radius: 50%;
  font-size: 10px;
  flex-shrink: 0;
}

.devtools-inspector-ack-label {
  flex: 1;
  font-size: 11px;
  font-weight: 500;
  color: var(--dt-success);
}

.devtools-inspector-ack-chevron {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--dt-success);
  opacity: 0.7;
}

.devtools-inspector-ack-details {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  background: var(--dt-bg-secondary);
  border-top: 1px solid rgba(34, 197, 94, 0.2);
}

.devtools-inspector-ack-detail-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.devtools-inspector-ack-detail-label {
  flex-shrink: 0;
  width: 110px;
  font-size: 10px;
  font-weight: 500;
  color: var(--dt-text-muted);
}

.devtools-inspector-ack-detail-value-container {
  flex: 1;
  display: flex;
  align-items: flex-start;
  gap: 6px;
  min-width: 0;
}

.devtools-inspector-ack-detail-value {
  flex: 1;
  font-family: var(--dt-font-mono);
  font-size: 10px;
  color: var(--dt-text-primary);
  word-break: break-all;
}

.devtools-inspector-ack-copy-icon {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  color: var(--dt-text-muted);
  background: var(--dt-bg-primary);
  border: 1px solid var(--dt-border);
  border-radius: 3px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 150ms, color 150ms, border-color 150ms;
}

.devtools-inspector-ack-detail-row:hover .devtools-inspector-ack-copy-icon {
  opacity: 1;
}

.devtools-inspector-ack-copy-icon:hover {
  color: var(--dt-info);
  border-color: var(--dt-info);
}

.devtools-inspector-ack-copy-icon.copied {
  color: var(--dt-success);
  border-color: var(--dt-success);
}

/* Payload Section */
.devtools-inspector-payload {
  position: relative;
  background: var(--dt-bg-tertiary);
  border: 1px solid var(--dt-border);
  border-radius: 6px;
  overflow: hidden;
}

.devtools-inspector-payload-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  background: var(--dt-bg-secondary);
  border-bottom: 1px solid var(--dt-border);
}

.devtools-inspector-payload-label {
  font-size: 10px;
  font-weight: 500;
  color: var(--dt-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.devtools-inspector-payload-content {
  padding: 10px;
  max-height: 50vh;
  overflow: auto;
  font-family: var(--dt-font-mono);
  font-size: 11px;
  line-height: 1.5;
  color: var(--dt-text-primary);
  white-space: pre-wrap;
  word-break: break-word;
}

/* ============================================
   Header Bar & Tabs
   ============================================ */

.devtools-header-bar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 10px;
  background: var(--dt-bg-secondary);
  border-bottom: 1px solid var(--dt-border);
  min-height: 34px;
}

.devtools-tab-bar {
  display: flex;
  align-items: stretch;
  gap: 2px;
  align-self: stretch;
}

.devtools-tab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 10px;
  font-size: 11px;
  font-weight: 500;
  font-family: inherit;
  color: var(--dt-text-secondary);
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
}

.devtools-tab:hover {
  color: var(--dt-text-primary);
  background: var(--dt-bg-hover);
}

.devtools-tab-active {
  color: var(--dt-info);
  border-bottom-color: var(--dt-info);
  font-weight: 600;
}

.devtools-tab-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 15px;
  padding: 0 4px;
  font-size: 9px;
  font-weight: 600;
  font-family: var(--dt-font-mono);
  color: var(--dt-text-secondary);
  background: var(--dt-bg-tertiary);
  border-radius: 8px;
}

.devtools-tab-active .devtools-tab-badge {
  color: white;
  background: var(--dt-info);
}

.devtools-connection-status {
  flex-shrink: 0;
}

.devtools-connection-status-clickable {
  padding: 3px 6px;
  border-radius: 4px;
  cursor: pointer;
}

.devtools-connection-status-clickable:hover {
  background: var(--dt-bg-hover);
}

/* ============================================
   Connection Popover
   ============================================ */

.devtools-popover {
  position: absolute;
  z-index: 100;
  width: 340px;
  max-height: 70%;
  overflow-y: auto;
  background: var(--dt-bg-primary);
  border: 1px solid var(--dt-border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  padding: 10px;
}

.devtools-popover-section + .devtools-popover-section {
  margin-top: 12px;
}

.devtools-popover-section-title {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--dt-text-muted);
  margin-bottom: 6px;
}

.devtools-popover-grid {
  display: grid;
  grid-template-columns: 100px 1fr;
  row-gap: 4px;
  column-gap: 10px;
  font-size: 11px;
}

.devtools-popover-stat-label {
  color: var(--dt-text-muted);
  font-weight: 500;
  white-space: nowrap;
}

.devtools-popover-stat-value {
  color: var(--dt-text-primary);
  font-family: var(--dt-font-mono);
  font-size: 10px;
  word-break: break-all;
}

.devtools-popover-timeline {
  display: flex;
  flex-direction: column;
  max-height: 220px;
  overflow-y: auto;
  border: 1px solid var(--dt-border);
  border-radius: 6px;
  background: var(--dt-bg-secondary);
}

.devtools-popover-timeline-row {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 4px 8px;
  font-size: 10px;
}

.devtools-popover-timeline-row + .devtools-popover-timeline-row {
  border-top: 1px solid var(--dt-border);
}

.devtools-popover-timeline-time {
  flex-shrink: 0;
  font-family: var(--dt-font-mono);
  color: var(--dt-text-muted);
}

.devtools-popover-timeline-dot {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.devtools-popover-timeline-label {
  flex: 1;
  min-width: 0;
  color: var(--dt-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.devtools-popover-timeline-duration {
  flex-shrink: 0;
  font-family: var(--dt-font-mono);
  color: var(--dt-text-muted);
}

.devtools-popover-empty {
  padding: 14px;
  text-align: center;
  color: var(--dt-text-muted);
  font-size: 11px;
}

/* ============================================
   Documents Tab
   ============================================ */

.devtools-doc-icon {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  color: var(--dt-text-muted);
}

.devtools-doc-name {
  flex: 0 1 auto;
  max-width: 40%;
}

.devtools-doc-lock {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  color: var(--dt-success);
}

.devtools-doc-lock svg {
  width: 11px;
  height: 11px;
}

.devtools-doc-meta {
  flex-shrink: 0;
  font-size: 10px;
  font-family: var(--dt-font-mono);
  color: var(--dt-text-muted);
  white-space: nowrap;
}

/* Sync stepper: three dots for sync-step-1 → sync-step-2 → sync-done */
.devtools-sync-indicator {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 18px;
  padding: 0 7px;
  border-radius: 9px;
  font-size: 10px;
  font-weight: 600;
}

.devtools-sync-synced {
  color: var(--dt-success);
  background: rgba(34, 197, 94, 0.12);
}

.devtools-sync-syncing {
  color: var(--dt-warning);
  background: rgba(245, 158, 11, 0.14);
}

.devtools-sync-idle {
  color: var(--dt-text-muted);
  background: var(--dt-bg-tertiary);
}

.devtools-sync-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.25;
}

.devtools-sync-dot-done {
  opacity: 1;
}

.devtools-sync-label {
  margin-left: 3px;
}

/* ============================================
   Presence Tab
   ============================================ */

.devtools-presence-dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.devtools-presence-user {
  flex-shrink: 0;
  font-weight: 600;
  color: var(--dt-text-primary);
}

.devtools-presence-data {
  margin: 6px 0 0 18px;
  padding: 8px;
  background: var(--dt-bg-tertiary);
  border: 1px solid var(--dt-border);
  border-radius: 4px;
  font-family: var(--dt-font-mono);
  font-size: 10px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 30vh;
  overflow-y: auto;
}

.devtools-presence-divider {
  padding: 6px 12px 4px;
  font-size: 9px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--dt-text-muted);
  background: var(--dt-bg-secondary);
  border-bottom: 1px solid var(--dt-border);
}

.devtools-presence-feed-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 12px;
  border-bottom: 1px solid var(--dt-border);
  font-size: 11px;
  color: var(--dt-text-secondary);
}

.devtools-presence-feed-arrow {
  flex-shrink: 0;
  font-weight: 700;
}

.devtools-presence-feed-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ============================================
   RPC Call Groups
   ============================================ */

.devtools-group-chevron {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  color: var(--dt-text-muted);
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

.devtools-group-chevron:hover {
  background: var(--dt-bg-tertiary);
  color: var(--dt-text-primary);
}

.devtools-rpc-group-badge {
  gap: 4px;
}

.devtools-rpc-bolt {
  display: inline-flex;
  align-items: center;
  opacity: 0.85;
}

.devtools-group-parts {
  flex-shrink: 0;
  font-size: 10px;
  font-family: var(--dt-font-mono);
  color: var(--dt-text-muted);
  white-space: nowrap;
}

/* Expanded call members: indented, slightly recessed */
.devtools-child-row {
  padding-left: 34px !important;
  background: var(--dt-bg-secondary);
  box-shadow: inset 22px 0 0 var(--dt-bg-secondary), inset 23px 0 0 var(--dt-border);
}

/* Status pills */
.devtools-status-pill {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 18px;
  padding: 0 7px;
  border-radius: 9px;
  font-size: 10px;
  font-weight: 600;
  font-family: var(--dt-font-mono);
  white-space: nowrap;
}

.devtools-status-pending {
  color: var(--dt-text-muted);
  background: var(--dt-bg-tertiary);
}

.devtools-status-streaming {
  color: var(--dt-info);
  background: rgba(59, 130, 246, 0.12);
}

.devtools-status-success {
  color: var(--dt-success);
  background: rgba(34, 197, 94, 0.12);
}

.devtools-status-error {
  color: var(--dt-error);
  background: rgba(239, 68, 68, 0.14);
}

/* Spinner for pending/streaming calls */
.devtools-spinner {
  width: 9px;
  height: 9px;
  border: 1.5px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: devtools-spin 700ms linear infinite;
}

@keyframes devtools-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .devtools-spinner { animation: none; opacity: 0.5; }
}

/* Progress bars (file transfers) */
.devtools-progress-wrapper {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.devtools-progress-track {
  width: 64px;
  height: 5px;
  background: var(--dt-bg-tertiary);
  border-radius: 3px;
  overflow: hidden;
}

.devtools-progress-track-lg {
  flex: 1;
  width: auto;
  height: 6px;
}

.devtools-progress-fill {
  height: 100%;
  background: var(--dt-info);
  border-radius: 3px;
  transition: width 200ms ease;
}

.devtools-progress-fill-error {
  background: var(--dt-error);
}

.devtools-progress-label {
  font-size: 10px;
  font-family: var(--dt-font-mono);
  color: var(--dt-text-muted);
  white-space: nowrap;
}

.devtools-inspector-progress-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px;
  border-bottom: 1px solid var(--dt-border);
}

/* Update operations (human-readable diff) */
.devtools-ops-box {
  background: var(--dt-bg-tertiary);
  border: 1px solid var(--dt-border);
  border-radius: 6px;
  overflow: hidden;
  max-height: 40vh;
  overflow-y: auto;
}

.devtools-ops-summary {
  padding: 6px 10px;
  background: var(--dt-bg-secondary);
  border-bottom: 1px solid var(--dt-border);
  font-size: 10px;
  font-weight: 500;
  color: var(--dt-text-muted);
}

.devtools-op-line {
  padding: 3px 10px;
  font-family: var(--dt-font-mono);
  font-size: 10px;
  line-height: 1.5;
  word-break: break-word;
  white-space: pre-wrap;
}

.devtools-op-line + .devtools-op-line {
  border-top: 1px solid var(--dt-border);
}

.devtools-op-insert { color: var(--dt-success); }
.devtools-op-delete { color: var(--dt-error); }
.devtools-op-gc, .devtools-op-skip { color: var(--dt-text-muted); }

/* Inspector error box */
.devtools-inspector-error-box {
  padding: 10px;
  background: rgba(239, 68, 68, 0.08);
  border: 1px solid rgba(239, 68, 68, 0.25);
  border-radius: 6px;
  color: var(--dt-error);
  font-size: 11px;
  font-family: var(--dt-font-mono);
  word-break: break-word;
}

/* Empty State */
.devtools-inspector-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 12px;
  color: var(--dt-text-muted);
}

.devtools-inspector-empty-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  background: var(--dt-bg-secondary);
  border: 1px solid var(--dt-border);
  border-radius: 12px;
  color: var(--dt-text-muted);
}

.devtools-inspector-empty-text {
  font-size: 12px;
  color: var(--dt-text-muted);
}
`;
