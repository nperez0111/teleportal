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
import { DevtoolEventHandlers } from "./events.js";
import { renderPanel } from "./renderer.js";
import { devtoolStyles, getBootstrapCDNLink } from "./styles.js";
import { debounce, filterMessages } from "../utils.js";

/**
 * Default message type configurations
 */
const DEFAULT_MESSAGE_TYPES: MessageTypeConfig[] = [
  { type: "doc", payloadType: "update", icon: "📝", label: "Update" },
  { type: "doc", payloadType: "sync-step-1", icon: "🔄", label: "Sync Step 1" },
  { type: "doc", payloadType: "sync-step-2", icon: "🔄", label: "Sync Step 2" },
  { type: "doc", payloadType: "sync-done", icon: "✅", label: "Sync Done" },
  { type: "doc", payloadType: "auth-message", icon: "🔐", label: "Auth" },
  { type: "awareness", payloadType: "awareness-update", icon: "👥", label: "Awareness Update" },
  { type: "awareness", payloadType: "awareness-request", icon: "👥", label: "Awareness Request" },
  { type: "ack", icon: "✓", label: "ACK" },
  { type: "file", icon: "📁", label: "File" },
];

/**
 * UI Panel controller that manages state and rendering
 */
export class DevtoolPanel {
  private container: HTMLElement | null = null;
  private state: PanelState;
  private eventHandlers: DevtoolEventHandlers | null = null;
  private renderDebounced: () => void;
  private messageTypes: MessageTypeConfig[];

  // Data
  private messages: MessageEntry[] = [];
  private stats: DevtoolStats = {
    messagesSent: 0,
    messagesReceived: 0,
    bytesSent: 0,
    bytesReceived: 0,
    startTime: Date.now(),
    documents: new Set(),
    peers: new Map(),
  };
  private connectionState: ConnectionState | null = null;
  private syncStates: Map<string, SyncState> = new Map();
  private peers: Map<number, PeerState> = new Map();

  constructor(initialTheme: Theme = "system") {
    // Load theme from localStorage
    const savedTheme = localStorage.getItem("tp-devtool-theme") as Theme | null;
    this.state = {
      selectedMessageId: null,
      selectedDocumentId: null,
      expandedSections: new Set(),
      filters: {
        direction: "all",
        messageTypes: new Set(),
        documentIds: new Set(),
        search: "",
      },
      theme: savedTheme ?? initialTheme,
      view: "messages",
    };

    this.messageTypes = DEFAULT_MESSAGE_TYPES;

    // Debounce renders to avoid excessive re-renders
    this.renderDebounced = debounce(() => {
      this.render();
    }, 100);
  }

  /**
   * Mount the panel to a container
   */
  mount(container: HTMLElement): void {
    this.container = container;

    // Inject Bootstrap CDN if not already present
    this.injectBootstrap();

    // Inject styles
    this.injectStyles();

    // Initial render
    this.render();

    // Attach event handlers
    this.attachEvents();
  }

  /**
   * Unmount the panel
   */
  unmount(): void {
    if (this.eventHandlers) {
      this.eventHandlers.detach();
      this.eventHandlers = null;
    }
    if (this.container) {
      this.container.innerHTML = "";
    }
    this.container = null;
  }

  /**
   * Update messages and trigger render
   */
  updateMessages(messages: MessageEntry[]): void {
    this.messages = messages;
    this.updateStats();
    this.renderDebounced();
  }

  /**
   * Update connection state
   */
  updateConnectionState(state: ConnectionState): void {
    this.connectionState = state;
    this.renderDebounced();
  }

  /**
   * Update sync state for a document
   */
  updateSyncState(documentId: string, synced: boolean): void {
    this.syncStates.set(documentId, {
      documentId,
      synced,
      timestamp: Date.now(),
    });
    this.updateStats();
    this.renderDebounced();
  }

  /**
   * Update peers
   */
  updatePeers(peers: Map<number, PeerState>): void {
    this.peers = peers;
    this.updateStats();
    this.renderDebounced();
  }

  /**
   * Update state
   */
  updateState(updates: Partial<PanelState>): void {
    this.state = { ...this.state, ...updates };

    // Persist theme to localStorage
    if (updates.theme) {
      localStorage.setItem("tp-devtool-theme", updates.theme);
    }

    this.renderDebounced();
  }

  /**
   * Get current state
   */
  getState(): PanelState {
    return { ...this.state };
  }

  /**
   * Render the panel
   */
  private render(): void {
    if (!this.container) return;

    // Get selected message and snapshot
    const selectedMessage = this.state.selectedMessageId
      ? this.messages.find((m) => m.id === this.state.selectedMessageId) ?? null
      : null;

    // Filter messages based on current filters
    const filteredMessages = filterMessages(this.messages, this.state.filters);

    // Render
    this.container.innerHTML = renderPanel(
      this.state,
      filteredMessages,
      this.stats,
      this.connectionState,
      this.syncStates,
      this.peers,
      selectedMessage,
      undefined, // Snapshot will be provided by devtool core
      this.messageTypes,
    );

    // Re-attach event handlers after render
    this.attachEvents();
  }

  /**
   * Attach event handlers
   */
  private attachEvents(): void {
    if (!this.container) return;

    if (this.eventHandlers) {
      this.eventHandlers.detach();
    }

    this.eventHandlers = new DevtoolEventHandlers(
      this.container,
      (updates) => {
        this.updateState(updates);
      },
      (action, data) => {
        this.handleAction(action, data);
      },
    );

    this.eventHandlers.attach();
  }

  /**
   * Handle actions
   */
  private handleAction(action: string, data?: any): void {
    switch (action) {
      case "clear-logs":
        // This will be handled by devtool core
        break;
      case "export-logs":
        this.exportLogs();
        break;
    }
  }

  /**
   * Export logs as JSON
   */
  private exportLogs(): void {
    const exportData = {
      messages: this.messages,
      stats: this.stats,
      connectionState: this.connectionState,
      syncStates: Array.from(this.syncStates.values()),
      peers: Array.from(this.peers.entries()).map(([id, peer]) => ({
        clientId: id,
        ...peer,
        documents: Array.from(peer.documents),
      })),
      exportedAt: new Date().toISOString(),
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `teleportal-devtool-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /**
   * Update statistics from current data
   */
  private updateStats(): void {
    let messagesSent = 0;
    let messagesReceived = 0;
    let bytesSent = 0;
    let bytesReceived = 0;

    for (const entry of this.messages) {
      if (entry.direction === "sent") {
        messagesSent++;
        bytesSent += entry.size;
      } else {
        messagesReceived++;
        bytesReceived += entry.size;
      }
    }

    // Update documents set
    const documents = new Set<string>();
    for (const entry of this.messages) {
      if (entry.documentId) {
        documents.add(entry.documentId);
      }
    }
    for (const syncState of this.syncStates.values()) {
      documents.add(syncState.documentId);
    }

    this.stats = {
      messagesSent,
      messagesReceived,
      bytesSent,
      bytesReceived,
      startTime: this.stats.startTime,
      documents,
      peers: this.peers,
    };
  }

  /**
   * Inject Bootstrap CDN if not already present
   */
  private injectBootstrap(): void {
    if (document.querySelector('link[href*="bootstrap"]')) {
      return; // Already injected
    }

    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css";
    link.crossOrigin = "anonymous";
    document.head.appendChild(link);
  }

  /**
   * Inject custom styles
   */
  private injectStyles(): void {
    // Check if styles are already injected
    if (document.getElementById("tp-devtool-styles")) {
      return;
    }

    const style = document.createElement("style");
    style.id = "tp-devtool-styles";
    style.textContent = devtoolStyles;
    document.head.appendChild(style);
  }

  /**
   * Apply theme to document
   */
  private applyTheme(): void {
    if (!this.container) return;

    let isDark = false;
    if (this.state.theme === "dark") {
      isDark = true;
    } else if (this.state.theme === "light") {
      isDark = false;
    } else {
      // System theme
      isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    }

    this.container.setAttribute("data-theme", isDark ? "dark" : "light");
    this.container.classList.toggle("dark", isDark);
    this.container.classList.toggle("light", !isDark);
  }
}
