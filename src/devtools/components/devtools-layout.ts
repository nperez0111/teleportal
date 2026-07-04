import { MessageList } from "./message-list";
import { MessageInspector } from "./message-inspector";
import { FiltersPanel } from "./filters-panel";
import { TabBar } from "./tab-bar";
import { ConnectionStatus } from "./connection-status";
import { ConnectionPopover, type ConnectionInfoSource } from "./connection-popover";
import { DocumentsPanel } from "./documents-panel";
import { PresencePanel } from "./presence-panel";
import type {
  DevtoolsMessage,
  DocumentState,
  Statistics,
  ConnectionStateInfo,
  FilterState,
} from "../types";
import type { FileTransferProgress } from "teleportal/protocols/file";
import type { PresenceFeedEntry, PresencePeer } from "../utils/presence-tracker";
import type { SettingsManager } from "../settings-manager";
import type { FilterManager } from "../filter-manager";

export type DevtoolsLayoutState = {
  filteredMessages: DevtoolsMessage[];
  connectionState: ConnectionStateInfo | null;
  statistics: Statistics | null;
  availableDocuments: string[];
  availableMessageTypes: string[];
  filters: FilterState;
  documents: DocumentState[];
  presencePeers: PresencePeer[];
  presenceFeed: PresenceFeedEntry[];
  transferProgress: ReadonlyMap<string, FileTransferProgress>;
};

export class DevtoolsLayout {
  private element: HTMLElement;
  private tabBar: TabBar;
  private connectionStatus: ConnectionStatus;
  private connectionPopover: ConnectionPopover | null = null;
  private messageList: MessageList;
  private messageInspector: MessageInspector;
  private filtersPanel: FiltersPanel;
  private documentsPanel: DocumentsPanel;
  private presencePanel: PresencePanel;
  private messagesView: HTMLElement;
  private documentsView: HTMLElement;
  private presenceView: HTMLElement;
  private selectedMessage: DevtoolsMessage | null = null;
  private selectedGroupKey: string | null = null;
  private onClearMessages: (() => void) | null = null;

  private prevFilteredMessages: DevtoolsMessage[] | null = null;
  private prevConnectionState: ConnectionStateInfo | null = null;
  private prevAvailableDocuments: string[] | null = null;
  private prevAvailableMessageTypes: string[] | null = null;
  private prevFilters: FilterState | null = null;
  private prevDocuments: DocumentState[] | null = null;
  private prevPresencePeers: PresencePeer[] | null = null;

  constructor(
    settingsManager: SettingsManager,
    filterManager: FilterManager,
    onClearMessages?: () => void,
    onTransportSwitch?: (name: string) => void,
    connectionInfoSource?: ConnectionInfoSource,
  ) {
    this.onClearMessages = onClearMessages || null;
    this.element = document.createElement("div");
    this.element.className = "devtools-container devtools-h-full devtools-w-full";

    // --- Header bar: tabs + connection status ---
    const headerBar = document.createElement("div");
    headerBar.className = "devtools-header-bar";

    this.tabBar = new TabBar(
      [
        { id: "messages", label: "Messages" },
        { id: "documents", label: "Documents" },
        { id: "presence", label: "Presence" },
      ],
      (id) => this.showTab(id),
    );
    headerBar.append(this.tabBar.getElement());

    const spacer = document.createElement("div");
    spacer.className = "devtools-flex-1";
    headerBar.append(spacer);

    this.connectionStatus = new ConnectionStatus(onTransportSwitch);
    headerBar.append(this.connectionStatus.getElement());

    this.element.append(headerBar);

    if (connectionInfoSource) {
      this.connectionPopover = new ConnectionPopover(connectionInfoSource);
      this.element.append(this.connectionPopover.getElement());
      const statusEl = this.connectionStatus.getElement();
      statusEl.classList.add("devtools-connection-status-clickable");
      statusEl.title = "Connection details & timeline";
      statusEl.addEventListener("click", () => {
        this.connectionPopover!.toggle(statusEl);
      });
    }

    // --- Messages view: filters + list + inspector ---
    this.messagesView = document.createElement("div");
    this.messagesView.className =
      "devtools-flex-1 devtools-flex devtools-flex-col devtools-overflow-hidden";

    this.filtersPanel = new FiltersPanel(
      settingsManager,
      (updates) => {
        filterManager.updateFilters(updates);
      },
      () => {
        filterManager.clearFilters();
      },
    );

    const filtersContainer = document.createElement("div");
    filtersContainer.className = "devtools-shrink-0 devtools-border-b devtools-border-gray-200";
    filtersContainer.append(this.filtersPanel.getElement());
    this.messagesView.append(filtersContainer);

    this.messageList = new MessageList(
      (message) => {
        this.selectedMessage = message;
        this.selectedGroupKey = null;
        this.messageInspector.setMessage(message);
        this.messageList.setSelection({ kind: "message", id: message.id });
      },
      (group) => {
        this.selectedMessage = null;
        this.selectedGroupKey = group.key;
        this.messageInspector.setGroup(group);
        this.messageList.setSelection({ kind: "group", key: group.key });
      },
      this.onClearMessages || undefined,
    );

    this.messageInspector = new MessageInspector();

    const mainContent = document.createElement("div");
    mainContent.className = "devtools-flex-1 devtools-flex devtools-overflow-hidden";

    const messageListContainer = document.createElement("div");
    messageListContainer.className =
      "devtools-flex-1 devtools-min-w-0 devtools-border-r devtools-border-gray-200";
    messageListContainer.append(this.messageList.getElement());
    mainContent.append(messageListContainer);

    const inspectorContainer = document.createElement("div");
    inspectorContainer.className = "devtools-w-96 devtools-shrink-0";
    inspectorContainer.append(this.messageInspector.getElement());
    mainContent.append(inspectorContainer);

    this.messagesView.append(mainContent);
    this.element.append(this.messagesView);

    // --- Documents view ---
    this.documentsPanel = new DocumentsPanel((docId) => {
      // Clicking a document filters the Messages tab to it.
      filterManager.updateFilters({ documentIds: [docId] });
      this.tabBar.setActive("messages");
      this.showTab("messages");
    });
    this.documentsView = document.createElement("div");
    this.documentsView.className =
      "devtools-flex-1 devtools-flex devtools-flex-col devtools-overflow-hidden";
    this.documentsView.style.display = "none";
    this.documentsView.append(this.documentsPanel.getElement());
    this.element.append(this.documentsView);

    // --- Presence view ---
    this.presencePanel = new PresencePanel();
    this.presenceView = document.createElement("div");
    this.presenceView.className =
      "devtools-flex-1 devtools-flex devtools-flex-col devtools-overflow-hidden";
    this.presenceView.style.display = "none";
    this.presenceView.append(this.presencePanel.getElement());
    this.element.append(this.presenceView);
  }

  private showTab(id: string) {
    this.messagesView.style.display = id === "messages" ? "" : "none";
    this.documentsView.style.display = id === "documents" ? "" : "none";
    this.presenceView.style.display = id === "presence" ? "" : "none";
  }

  update(state: DevtoolsLayoutState) {
    const {
      filteredMessages,
      connectionState,
      availableDocuments,
      availableMessageTypes,
      filters,
      documents,
      presencePeers,
      presenceFeed,
      transferProgress,
    } = state;

    // The progress map is mutated in place; its contents changing always
    // bumps the generation, which yields a fresh filteredMessages array —
    // so this branch re-runs whenever progress updates.
    if (filteredMessages !== this.prevFilteredMessages) {
      this.messageList.setMessages(filteredMessages, transferProgress);
      if (this.selectedMessage) {
        const stillExists = filteredMessages.some((m) => m.id === this.selectedMessage!.id);
        if (stillExists) {
          this.messageList.setSelection({ kind: "message", id: this.selectedMessage.id });
        } else {
          this.selectedMessage = null;
          this.messageInspector.setMessage(null);
          this.messageList.setSelection(null);
        }
      } else if (this.selectedGroupKey) {
        // Re-resolve the group so a selected call inspector tracks live
        // progress (new parts, response arrival, ACKs).
        const group = this.messageList.getGroup(this.selectedGroupKey);
        if (group) {
          this.messageInspector.setGroup(group);
          this.messageList.setSelection({ kind: "group", key: group.key });
        } else {
          this.selectedGroupKey = null;
          this.messageInspector.setGroup(null);
          this.messageList.setSelection(null);
        }
      }
      this.prevFilteredMessages = filteredMessages;
    }

    if (connectionState !== this.prevConnectionState) {
      this.connectionStatus.update(connectionState);
      this.prevConnectionState = connectionState;
    }

    if (
      filters !== this.prevFilters ||
      availableDocuments !== this.prevAvailableDocuments ||
      availableMessageTypes !== this.prevAvailableMessageTypes
    ) {
      this.filtersPanel.update(filters, availableDocuments, availableMessageTypes);
      this.prevFilters = filters;
      this.prevAvailableDocuments = availableDocuments;
      this.prevAvailableMessageTypes = availableMessageTypes;
    }

    if (documents !== this.prevDocuments) {
      this.documentsPanel.update(documents);
      this.tabBar.setBadge("documents", documents.length > 0 ? String(documents.length) : null);
      this.prevDocuments = documents;
    }

    if (presencePeers !== this.prevPresencePeers) {
      this.presencePanel.update(presencePeers, presenceFeed);
      this.tabBar.setBadge(
        "presence",
        presencePeers.length > 0 ? String(presencePeers.length) : null,
      );
      this.prevPresencePeers = presencePeers;
    }
  }

  getElement(): HTMLElement {
    return this.element;
  }

  destroy() {
    this.connectionStatus.destroy();
    this.connectionPopover?.destroy();
    this.filtersPanel.destroy();
    this.documentsPanel.destroy();
    this.presencePanel.destroy();
  }
}
