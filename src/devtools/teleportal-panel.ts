import type { MessageEntry, TeleportalEventClient } from "./event-client.js";
import { panelStyles } from "./panel-styles.js";
import type {
  PanelOptions,
  ConnectionTimelineEntry,
  MessageTypeConfig,
  Milestone,
  Theme,
} from "./panel-types.js";
import * as Renderers from "./panel-renderers.js";
import * as Utils from "./panel-utils.js";

export type { PanelOptions };

const DEFAULT_MESSAGE_TYPES: MessageTypeConfig[] = [
  { type: "doc", payloadType: "update", icon: "📝", label: "Update" },
  { type: "doc", payloadType: "sync-step-1", icon: "🔄", label: "Sync Step 1" },
  { type: "doc", payloadType: "sync-step-2", icon: "🔄", label: "Sync Step 2" },
  { type: "doc", payloadType: "sync-done", icon: "✅", label: "Sync Done" },
  { type: "doc", payloadType: "auth-message", icon: "🔐", label: "Auth" },
  {
    type: "awareness",
    payloadType: "awareness-update",
    icon: "👥",
    label: "Awareness Update",
  },
  {
    type: "awareness",
    payloadType: "awareness-request",
    icon: "👥",
    label: "Awareness Request",
  },
  { type: "file", payloadType: undefined, icon: "📁", label: "File" },
  { type: "doc", payloadType: undefined, icon: "📄", label: "Doc" },
];

export class TeleportalDevtoolsPanel {
  private eventClient: TeleportalEventClient;
  private container: HTMLElement | null = null;
  private maxMessageEntries: number;
  private cleanupFns: (() => void)[] = [];

  private connectionTimeline: ConnectionTimelineEntry[] = [];
  private messageLog: MessageEntry[] = [];
  private currentSyncState: { documentId: string; synced: boolean } | null =
    null;
  private currentAwarenessState: {
    peers: Map<number, Record<string, unknown>>;
  } | null = null;

  private expandedMessages: Set<string> = new Set();
  private expandedAwarenessItems: Set<string> = new Set();
  private ackedMessages: Set<string> = new Set();
  private selectedMessageId: string | null = null;
  private selectedMilestoneId: string | null = null;

  private theme: Theme = "system";
  private filters: {
    direction: "all" | "sent" | "received";
    types: Set<string>;
    search: string;
  } = {
    direction: "all",
    types: new Set(),
    search: "",
  };
  private readonly messageTypes = DEFAULT_MESSAGE_TYPES;
  private milestones: Milestone[] = [];
  private stats = {
    sent: 0,
    received: 0,
    bytesSent: 0,
    bytesReceived: 0,
    startTime: Date.now(),
  };

  constructor(options: PanelOptions) {
    this.eventClient = options.eventClient;
    this.maxMessageEntries = options.maxMessageEntries ?? 200;

    const savedTheme = localStorage.getItem("tp-theme") as Theme | null;
    if (savedTheme) {
      this.theme = savedTheme;
    }

    const savedAwareness = localStorage.getItem("tp-expanded-awareness");
    if (savedAwareness) {
      try {
        const items = JSON.parse(savedAwareness) as string[];
        this.expandedAwarenessItems = new Set(items);
      } catch {
        // Ignore
      }
    }
  }

  mount(container: HTMLElement): void {
    this.container = container;
    this.applyTheme();
    this.render();
    this.subscribe();
  }

  unmount(): void {
    this.cleanupFns.forEach((fn) => fn());
    this.cleanupFns = [];
    this.container = null;
  }

  private applyTheme(): void {
    let isDark = false;

    if (this.theme === "dark") {
      isDark = true;
    } else if (this.theme === "light") {
      isDark = false;
    } else {
      isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    }

    document.documentElement.classList.toggle("tp-theme-dark", isDark);
    localStorage.setItem("tp-theme", this.theme);
  }

  private render(): void {
    if (!this.container) return;

    const filteredMessages = Utils.filterMessages(
      this.messageLog,
      this.filters,
    );
    const connectionState = this.getCurrentConnectionState();
    const selectedEntry = this.selectedMessageId
      ? this.messageLog.find((e) => e.message.id === this.selectedMessageId)
      : null;
    const typeCounts = Utils.countMessagesByType(
      this.messageLog,
      this.messageTypes,
    );

    this.container.innerHTML = `
      <style>${panelStyles}</style>
      <div class="tp-panel">
        <div class="tp-panel-left">
          ${Renderers.renderPanelHeader(this.theme, this.stats)}
          ${Renderers.renderToolbar(this.filters)}
          ${Renderers.renderTypeFilters(this.messageTypes, this.filters.types, typeCounts)}
          ${Renderers.renderStatusCards(connectionState, this.currentSyncState, this.currentAwarenessState?.peers?.size ?? 0)}
          ${Renderers.renderAwarenessSection(this.currentAwarenessState?.peers ?? null, this.expandedAwarenessItems)}
          ${Renderers.renderMilestonesSection(this.milestones, this.selectedMilestoneId)}
          ${Renderers.renderMessagesSection(filteredMessages, this.selectedMessageId, this.ackedMessages)}
          ${Renderers.renderFooter(this.stats)}
        </div>

        <div class="tp-panel-right">
          ${
            selectedEntry
              ? Renderers.renderDetailPanel(selectedEntry, this.ackedMessages)
              : Renderers.renderDetailEmpty()
          }
        </div>
      </div>
    `;

    this.attachEventListeners();
  }

  private getCurrentConnectionState(): {
    state: string;
    transport: string | null;
  } {
    const timeline = this.connectionTimeline;
    if (timeline.length === 0) {
      return { state: "disconnected", transport: null };
    }
    const last = timeline[timeline.length - 1];
    return { state: last.state, transport: last.transport };
  }

  private attachEventListeners(): void {
    const panel = this.container?.querySelector(".tp-panel");
    if (!panel) return;

    panel.querySelectorAll(".tp-filter-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const direction = btn.getAttribute("data-direction") as
          | "all"
          | "sent"
          | "received";
        this.filters.direction = direction;
        this.render();
      });
    });

    panel
      .querySelector("#tp-search-input")
      ?.addEventListener("input", (e: Event) => {
        const target = e.target as HTMLInputElement;
        this.filters.search = target.value;
        this.render();
      });

    panel.querySelector("#tp-clear-logs")?.addEventListener("click", () => {
      this.messageLog = [];
      this.stats = {
        sent: 0,
        received: 0,
        bytesSent: 0,
        bytesReceived: 0,
        startTime: Date.now(),
      };
      this.expandedMessages.clear();
      this.ackedMessages.clear();
      this.render();
    });

    panel.querySelectorAll(".tp-type-filter input").forEach((checkbox) => {
      checkbox.addEventListener("change", () => {
        const input = checkbox as HTMLInputElement;
        const type = checkbox.getAttribute("data-type");
        if (type) {
          if (input.checked) {
            this.filters.types.add(type);
          } else {
            this.filters.types.delete(type);
          }
          this.render();
        }
      });
    });

    panel.querySelector("#tp-clear-types")?.addEventListener("click", () => {
      this.filters.types.clear();
      this.render();
    });

    panel.querySelectorAll(".tp-awareness-header").forEach((header) => {
      header.addEventListener("click", () => {
        const item = header.parentElement;
        if (item) {
          const clientId = item.getAttribute("data-client-id");
          if (clientId) {
            if (this.expandedAwarenessItems.has(clientId)) {
              this.expandedAwarenessItems.delete(clientId);
            } else {
              this.expandedAwarenessItems.add(clientId);
            }
            localStorage.setItem(
              "tp-expanded-awareness",
              JSON.stringify([...this.expandedAwarenessItems]),
            );
            item.classList.toggle("expanded");
          }
        }
      });
    });

    panel.querySelectorAll(".tp-message").forEach((msg) => {
      msg.addEventListener("click", () => {
        const id = msg.getAttribute("data-id");
        if (id) {
          this.selectedMessageId = id;
          this.render();
        }
      });
    });

    panel.querySelector("#tp-close-detail")?.addEventListener("click", () => {
      this.selectedMessageId = null;
      this.render();
    });

    panel.querySelector("#tp-copy-id")?.addEventListener("click", () => {
      if (this.selectedMessageId) {
        navigator.clipboard.writeText(this.selectedMessageId);
      }
    });
  }

  private subscribe(): void {
    const unsubscribers: (() => void)[] = [];

    unsubscribers.push(
      this.eventClient.on("connection-state", (event) => {
        const payload = event.payload;
        this.connectionTimeline.push({
          state: payload.type,
          transport: payload.transport,
          timestamp: payload.timestamp,
        });
        if (this.connectionTimeline.length > 50) {
          this.connectionTimeline.shift();
        }
        this.render();
      }),
    );

    unsubscribers.push(
      this.eventClient.on("message-log", (event) => {
        const entry = event.payload;
        this.messageLog.unshift(entry);

        const existingIndex = this.messageLog.findIndex(
          (e) => e.message.id === entry.message.id && e !== entry,
        );
        if (existingIndex !== -1) {
          this.messageLog.splice(existingIndex, 1);
        }

        if (this.messageLog.length > this.maxMessageEntries) {
          this.messageLog.pop();
        }

        if (entry.message.type === "ack") {
          this.ackedMessages.add(entry.message.payload.messageId);
        }

        if (entry.direction === "sent") {
          this.stats.sent++;
        } else {
          this.stats.received++;
        }

        this.render();
      }),
    );

    unsubscribers.push(
      this.eventClient.on("sync-state", (event) => {
        const payload = event.payload;
        this.currentSyncState = {
          documentId: payload.documentId,
          synced: payload.synced,
        };
        this.render();
      }),
    );

    unsubscribers.push(
      this.eventClient.on("awareness-state", (event) => {
        const payload = event.payload;
        this.currentAwarenessState = {
          peers: payload.peers,
        };
        this.render();
      }),
    );

    this.cleanupFns = unsubscribers;
  }
}
