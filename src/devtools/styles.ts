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
.devtools-py-0\.5 { padding-top: 2px; padding-bottom: 2px; }
.devtools-py-1 { padding-top: 3px; padding-bottom: 3px; }
.devtools-py-1\.5 { padding-top: 4px; padding-bottom: 4px; }
.devtools-p-1\.5 { padding: 4px; }
.devtools-p-2 { padding: 6px; }
.devtools-p-3 { padding: 8px; }
.devtools-p-4 { padding: 12px; }
.devtools-mt-0\.5 { margin-top: 2px; }
.devtools-mb-0\.5 { margin-bottom: 2px; }
.devtools-mb-1 { margin-bottom: 4px; }
.devtools-gap-1 { gap: 4px; }
.devtools-gap-1\.5 { gap: 8px; }
.devtools-gap-2 { gap: 10px; }
.devtools-gap-3 { gap: 14px; }
.devtools-space-y-0\.5 > * + * { margin-top: 2px; }
.devtools-space-y-1 > * + * { margin-top: 4px; }
.devtools-space-y-1\.5 > * + * { margin-top: 6px; }
.devtools-space-y-2 > * + * { margin-top: 8px; }

/* Typography */
.devtools-text-xs { font-size: 11px; line-height: 1.4; }
.devtools-text-sm { font-size: 12px; line-height: 1.4; }
.devtools-text-base { font-size: 13px; line-height: 1.4; }
.devtools-text-lg { font-size: 14px; line-height: 1.4; }
.devtools-text-\[10px\] { font-size: 11px; }
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
.devtools-w-1\.5 { width: 5px; height: 5px; }
.devtools-w-2 { width: 6px; height: 6px; }
.devtools-w-3 { width: 10px; }
.devtools-w-4 { width: 14px; }
.devtools-w-16 { width: 50px; }
.devtools-w-32 { width: auto; min-width: 70px; } /* Badge - auto width */
.devtools-w-96 { width: 320px; }
.devtools-h-1\.5 { height: 5px; }
.devtools-h-2 { height: 6px; }
.devtools-min-w-\[60px\] { min-width: 50px; }
.devtools-max-h-24 { max-height: 5rem; }
.devtools-max-h-32 { max-height: 6rem; }
.devtools-max-h-48 { max-height: 10rem; }
.devtools-max-h-\[60vh\] { max-height: 60vh; }

/* Interactive */
.devtools-cursor-pointer { cursor: pointer; }
.devtools-transition-colors { transition: background-color 100ms; }
.devtools-hover\:bg-gray-50:hover { background: var(--dt-bg-hover); }
.devtools-hover\:bg-gray-200:hover { background: var(--dt-bg-tertiary); }
.devtools-hover\:text-gray-900:hover { color: var(--dt-text-primary); }
.devtools-hover\:underline:hover { text-decoration: underline; }

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

/* Message List Item - Dense */
.devtools-px-2.devtools-py-1\.5.devtools-border-b {
  padding: 6px 10px;
  border-bottom: 1px solid var(--dt-border);
  background: var(--dt-bg-primary);
}
.devtools-px-2.devtools-py-1\.5.devtools-border-b:hover {
  background: var(--dt-bg-hover);
}

/* Selected Item */
.devtools-bg-blue-50 {
  background: var(--dt-bg-selected) !important;
}

/* Message Row Layout */
.devtools-message-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* Type Badge - Fixed width */
.devtools-type-badge {
  flex-shrink: 0;
  width: 100px;
  padding: 2px 0;
  border-radius: 3px;
  font-size: 11px;
  font-weight: 500;
  text-align: center;
  color: white;
}

/* ACK Indicator */
.devtools-ack-indicator {
  flex-shrink: 0;
  color: var(--dt-success);
  font-size: 12px;
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
}

/* Timestamp */
.devtools-message-time {
  flex-shrink: 0;
  width: 60px;
  text-align: right;
  font-size: 10px;
  color: var(--dt-text-muted);
  white-space: nowrap;
}

/* Panel Headers - Compact */
.devtools-px-2.devtools-py-1.devtools-border-b.devtools-bg-gray-50 {
  padding: 6px 8px;
  background: var(--dt-bg-secondary);
}

/* Inspector */
.devtools-p-1\.5.devtools-rounded.devtools-space-y-1\.5 {
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

.devtools-hover\:bg-gray-50.devtools-px-1.devtools-py-0\.5.devtools-rounded {
  padding: 3px 5px;
  border-radius: 2px;
}
.devtools-hover\:bg-gray-50.devtools-px-1.devtools-py-0\.5.devtools-rounded:hover {
  background: var(--dt-bg-hover);
}

/* Filter Indicator */
.devtools-w-1\.5.devtools-h-1\.5.devtools-rounded-full.devtools-bg-green-500 {
  width: 5px;
  height: 5px;
  background: var(--dt-success);
}


/* Empty State */
.devtools-p-4.devtools-text-center.devtools-text-xs.devtools-text-gray-500 {
  padding: 20px 12px;
  color: var(--dt-text-muted);
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
  width: 14px;
  height: 14px;
}

.devtools-direction-icon svg {
  display: block;
}

.devtools-direction-sent {
  color: #3b82f6;
}

.devtools-direction-received {
  color: #22c55e;
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
`;
