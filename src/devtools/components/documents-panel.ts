import type { DocumentState, DocumentSyncPhase } from "../types";
import { formatBytes, formatRelativeTime } from "../utils/message-utils";
import { cloneSvg, ICON_DOCUMENT, ICON_LOCK_CLOSED } from "../utils/svg-cache";

const PHASE_LABEL: Record<DocumentSyncPhase, string> = {
  idle: "not synced",
  "sync-step-1": "syncing",
  "sync-step-2": "syncing",
  synced: "synced",
};

function createSyncIndicator(phase: DocumentSyncPhase): HTMLElement {
  const wrapper = document.createElement("span");
  wrapper.className = `devtools-sync-indicator devtools-sync-${phase === "synced" ? "synced" : phase === "idle" ? "idle" : "syncing"}`;
  wrapper.title =
    phase === "synced"
      ? "Sync handshake complete"
      : phase === "idle"
        ? "No sync activity on the current connection"
        : `Sync in progress (${phase})`;

  // Three-dot stepper: sync-step-1 → sync-step-2 → sync-done
  const steps: DocumentSyncPhase[] = ["sync-step-1", "sync-step-2", "synced"];
  const reached = phase === "idle" ? -1 : steps.indexOf(phase);
  for (let i = 0; i < steps.length; i++) {
    const dot = document.createElement("span");
    dot.className = `devtools-sync-dot${i <= reached ? " devtools-sync-dot-done" : ""}`;
    wrapper.append(dot);
  }

  const label = document.createElement("span");
  label.className = "devtools-sync-label";
  label.textContent = PHASE_LABEL[phase];
  wrapper.append(label);

  return wrapper;
}

/**
 * Documents tab: tree of main documents and their subdocuments with live
 * sync state, traffic counters, and last activity.
 */
export class DocumentsPanel {
  private element: HTMLElement;
  private listContainer: HTMLElement;
  private documents: DocumentState[] = [];
  private onSelectDocument: (docId: string) => void;
  private refreshInterval: ReturnType<typeof setInterval> | null = null;

  constructor(onSelectDocument: (docId: string) => void) {
    this.onSelectDocument = onSelectDocument;

    this.element = document.createElement("div");
    this.element.className = "devtools-flex devtools-flex-col devtools-h-full devtools-bg-white";

    const header = document.createElement("div");
    header.className = "devtools-list-header";
    const title = document.createElement("h2");
    title.className = "devtools-list-header-title";
    title.textContent = "Documents";
    header.append(title);
    this.element.append(header);

    this.listContainer = document.createElement("div");
    this.listContainer.className = "devtools-flex-1 devtools-overflow-y-auto";
    this.element.append(this.listContainer);

    // Keep relative timestamps fresh while the panel is visible.
    this.refreshInterval = setInterval(() => {
      if (this.element.isConnected && this.documents.length > 0) {
        this.render();
      }
    }, 1000);

    this.render();
  }

  update(documents: DocumentState[]) {
    this.documents = documents;
    this.render();
  }

  private render() {
    this.listContainer.innerHTML = "";

    if (this.documents.length === 0) {
      const empty = document.createElement("div");
      empty.className = "devtools-p-4 devtools-text-center devtools-text-xs devtools-text-gray-500";
      empty.textContent = "No documents yet";
      this.listContainer.append(empty);
      return;
    }

    const byParent = new Map<string | undefined, DocumentState[]>();
    const ids = new Set(this.documents.map((d) => d.id));
    for (const doc of this.documents) {
      // Docs whose parent isn't tracked render at the root.
      const parent = doc.parentId && ids.has(doc.parentId) ? doc.parentId : undefined;
      const list = byParent.get(parent) ?? [];
      list.push(doc);
      byParent.set(parent, list);
    }

    const appendLevel = (parent: string | undefined, depth: number) => {
      const docs = byParent.get(parent);
      if (!docs) return;
      for (const doc of docs) {
        this.listContainer.append(this.renderRow(doc, depth));
        appendLevel(doc.id, depth + 1);
      }
    };
    appendLevel(undefined, 0);
  }

  private renderRow(doc: DocumentState, depth: number): HTMLElement {
    const item = document.createElement("div");
    item.className =
      "devtools-px-2 devtools-py-1.5 devtools-border-b devtools-border-gray-200 devtools-cursor-pointer devtools-hover:bg-gray-50 devtools-transition-colors devtools-text-xs";
    item.title = "Click to filter the Messages tab to this document";
    item.addEventListener("click", () => this.onSelectDocument(doc.id));

    const row = document.createElement("div");
    row.className = "devtools-message-row";
    if (depth > 0) {
      row.style.paddingLeft = `${depth * 18}px`;
    }

    const icon = document.createElement("span");
    icon.className = "devtools-doc-icon";
    icon.append(cloneSvg(ICON_DOCUMENT));
    row.append(icon);

    const name = document.createElement("span");
    name.className = "devtools-message-doc devtools-doc-name";
    name.textContent = doc.name;
    name.title = doc.id;
    row.append(name);

    row.append(createSyncIndicator(doc.syncPhase));

    if (doc.encrypted) {
      const lock = document.createElement("span");
      lock.className = "devtools-doc-lock";
      lock.title = "End-to-end encrypted";
      lock.append(cloneSvg(ICON_LOCK_CLOSED));
      row.append(lock);
    }

    const traffic = document.createElement("span");
    traffic.className = "devtools-doc-meta";
    traffic.textContent = `${doc.messageCount} msg${doc.messageCount === 1 ? "" : "s"}`;
    traffic.title = `↑ ${formatBytes(doc.bytesSent)} sent · ↓ ${formatBytes(doc.bytesReceived)} received`;
    row.append(traffic);

    const bytes = document.createElement("span");
    bytes.className = "devtools-doc-meta";
    bytes.textContent = formatBytes(doc.bytesSent + doc.bytesReceived);
    row.append(bytes);

    const activity = document.createElement("span");
    activity.className = "devtools-message-time";
    activity.textContent = formatRelativeTime(doc.lastActivity);
    row.append(activity);

    item.append(row);
    return item;
  }

  getElement(): HTMLElement {
    return this.element;
  }

  destroy() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }
}
