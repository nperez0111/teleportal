import type { DocumentState, DocumentSyncPhase } from "../types";
import { formatBytes, formatRelativeTime } from "../utils/message-utils";
import {
  cloneSvg,
  ICON_DOCUMENT,
  ICON_LOCK_CLOSED,
  ICON_COPY,
  ICON_CHECK,
} from "../utils/svg-cache";

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

function docToJson(doc: DocumentState): string {
  try {
    return JSON.stringify(doc.provider.doc.toJSON(), null, 2);
  } catch {
    return "// Unable to read document contents";
  }
}

/**
 * Documents tab: list of documents on the left, document inspector on the
 * right showing live JSON contents of the selected document's Y.Doc.
 *
 * The inspector DOM is built once per selection and patched in place on each
 * 1-second tick so scroll position and interactive state survive refreshes.
 */
export class DocumentsPanel {
  private element: HTMLElement;
  private listContainer: HTMLElement;
  private inspectorContainer: HTMLElement;
  private documents: DocumentState[] = [];
  private selectedDocId: string | null = null;
  private onFilterMessages: (docId: string) => void;
  private refreshInterval: ReturnType<typeof setInterval> | null = null;

  // Stable inspector elements — created once per selection, patched in place.
  private inspectorDocId: string | null = null;
  private inspectorFields: {
    titleEl: HTMLElement;
    syncValue: HTMLElement;
    messagesValue: HTMLElement;
    trafficValue: HTMLElement;
    encryptedValue: HTMLElement;
    parentRow: HTMLElement;
    parentValue: HTMLElement;
    jsonContent: HTMLElement;
  } | null = null;

  constructor(onFilterMessages: (docId: string) => void) {
    this.onFilterMessages = onFilterMessages;

    this.element = document.createElement("div");
    this.element.className = "devtools-flex devtools-flex-col devtools-h-full devtools-bg-white";

    const header = document.createElement("div");
    header.className = "devtools-list-header";
    const title = document.createElement("h2");
    title.className = "devtools-list-header-title";
    title.textContent = "Documents";
    header.append(title);
    this.element.append(header);

    const mainContent = document.createElement("div");
    mainContent.className = "devtools-flex-1 devtools-flex devtools-overflow-hidden";

    // Left: document list
    const listPane = document.createElement("div");
    listPane.className =
      "devtools-flex-1 devtools-min-w-0 devtools-border-r devtools-border-gray-200";
    this.listContainer = document.createElement("div");
    this.listContainer.className = "devtools-flex-1 devtools-overflow-y-auto devtools-h-full";
    listPane.append(this.listContainer);
    mainContent.append(listPane);

    // Right: document inspector
    this.inspectorContainer = document.createElement("div");
    this.inspectorContainer.className = "devtools-doc-inspector";
    mainContent.append(this.inspectorContainer);

    this.element.append(mainContent);

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
    this.renderList();
    this.renderInspector();
  }

  private renderList() {
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
    const isSelected = doc.id === this.selectedDocId;
    item.className = `devtools-doc-row${isSelected ? " devtools-doc-row-selected" : ""}`;
    item.addEventListener("click", () => {
      this.selectedDocId = doc.id;
      this.render();
    });

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

  private renderInspector() {
    const selectedDoc = this.selectedDocId
      ? this.documents.find((d) => d.id === this.selectedDocId)
      : null;

    // Selection changed — rebuild inspector structure.
    if (this.inspectorDocId !== (selectedDoc?.id ?? null)) {
      this.inspectorDocId = selectedDoc?.id ?? null;
      this.inspectorFields = null;
      this.inspectorContainer.innerHTML = "";

      if (!selectedDoc) {
        const empty = document.createElement("div");
        empty.className = "devtools-inspector-empty";
        const icon = document.createElement("div");
        icon.className = "devtools-inspector-empty-icon";
        icon.append(cloneSvg(ICON_DOCUMENT));
        empty.append(icon);
        const text = document.createElement("div");
        text.className = "devtools-inspector-empty-text";
        text.textContent = "Select a document to inspect";
        empty.append(text);
        this.inspectorContainer.append(empty);
        return;
      }

      this.inspectorFields = this.buildInspector(selectedDoc);
    }

    // Patch values in place (no DOM rebuild, preserves scroll).
    if (selectedDoc && this.inspectorFields) {
      this.patchInspector(selectedDoc, this.inspectorFields);
    }
  }

  private buildInspector(doc: DocumentState) {
    // Header
    const header = document.createElement("div");
    header.className = "devtools-inspector-header";

    const titleEl = document.createElement("div");
    titleEl.className = "devtools-inspector-title";
    header.append(titleEl);

    const btnGroup = document.createElement("div");
    btnGroup.className = "devtools-inspector-btn-group";

    const filterBtn = document.createElement("button");
    filterBtn.className = "devtools-inspector-copy-btn";
    filterBtn.textContent = "Filter Messages";
    filterBtn.title = "Filter the Messages tab to this document";
    filterBtn.addEventListener("click", () => this.onFilterMessages(doc.id));
    btnGroup.append(filterBtn);

    const copyBtn = document.createElement("button");
    copyBtn.className = "devtools-inspector-copy-btn";
    copyBtn.append(cloneSvg(ICON_COPY), " Copy JSON");
    copyBtn.title = "Copy the document JSON to clipboard";
    copyBtn.addEventListener("click", () => {
      const currentDoc = this.documents.find((d) => d.id === this.selectedDocId);
      if (!currentDoc) return;
      const json = docToJson(currentDoc);
      navigator.clipboard.writeText(json).then(() => {
        copyBtn.replaceChildren(cloneSvg(ICON_CHECK), " Copied");
        copyBtn.classList.add("copied");
        setTimeout(() => {
          copyBtn.replaceChildren(cloneSvg(ICON_COPY), " Copy JSON");
          copyBtn.classList.remove("copied");
        }, 1500);
      });
    });
    btnGroup.append(copyBtn);

    header.append(btnGroup);
    this.inspectorContainer.append(header);

    // Metadata card
    const metaSection = document.createElement("div");
    metaSection.className = "devtools-inspector-content";
    const card = document.createElement("div");
    card.className = "devtools-doc-meta-card";

    const makeField = (label: string): HTMLElement => {
      const labelEl = document.createElement("span");
      labelEl.className = "devtools-popover-stat-label";
      labelEl.textContent = label;
      const valueEl = document.createElement("span");
      valueEl.className = "devtools-popover-stat-value";
      card.append(labelEl, valueEl);
      return valueEl;
    };

    const idValue = makeField("ID");
    idValue.textContent = doc.id;
    const syncValue = makeField("Sync");
    const messagesValue = makeField("Messages");
    const trafficValue = makeField("Traffic");
    const encryptedValue = makeField("Encrypted");

    // Parent row (conditionally visible)
    const parentLabelEl = document.createElement("span");
    parentLabelEl.className = "devtools-popover-stat-label";
    parentLabelEl.textContent = "Parent";
    const parentValue = document.createElement("span");
    parentValue.className = "devtools-popover-stat-value";
    card.append(parentLabelEl, parentValue);
    const parentRow = parentLabelEl; // use label to toggle visibility of both

    metaSection.append(card);
    this.inspectorContainer.append(metaSection);

    // JSON contents
    const jsonSection = document.createElement("div");
    jsonSection.className = "devtools-doc-json-section";

    const jsonLabel = document.createElement("div");
    jsonLabel.className = "devtools-popover-section-title";
    jsonLabel.textContent = "Document Contents";
    jsonSection.append(jsonLabel);

    const jsonBox = document.createElement("div");
    jsonBox.className = "devtools-doc-json";
    const jsonContent = document.createElement("pre");
    jsonContent.className = "devtools-doc-json-content";
    jsonBox.append(jsonContent);
    jsonSection.append(jsonBox);
    this.inspectorContainer.append(jsonSection);

    const fields = {
      titleEl,
      syncValue,
      messagesValue,
      trafficValue,
      encryptedValue,
      parentRow,
      parentValue,
      jsonContent,
    };
    this.patchInspector(doc, fields);
    return fields;
  }

  private patchInspector(doc: DocumentState, f: NonNullable<typeof this.inspectorFields>) {
    f.titleEl.textContent = doc.name;
    f.titleEl.title = doc.id;
    f.syncValue.textContent = PHASE_LABEL[doc.syncPhase];
    f.messagesValue.textContent = String(doc.messageCount);
    f.trafficValue.textContent = `↑ ${formatBytes(doc.bytesSent)} · ↓ ${formatBytes(doc.bytesReceived)}`;
    f.encryptedValue.textContent = doc.encrypted ? "Yes" : "No";

    const showParent = doc.isSubdoc && !!doc.parentId;
    f.parentRow.style.display = showParent ? "" : "none";
    f.parentValue.style.display = showParent ? "" : "none";
    if (showParent) {
      f.parentValue.textContent = doc.parentId!;
    }

    f.jsonContent.textContent = docToJson(doc);
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
