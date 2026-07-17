import type { ConnectionStateInfo, ConnectionTimelineEntry, Statistics } from "../types";
import { formatDuration } from "../utils/message-utils";

export type ConnectionInfoSource = {
  getConnectionState(): ConnectionStateInfo | null;
  getConnection(): any;
  getTimeline(): ConnectionTimelineEntry[];
  getStatistics(): Statistics;
  getLastConnectedAt(): number | null;
  toggleConnection(): void;
};

const TIMELINE_DOT_COLOR: Record<ConnectionTimelineEntry["kind"], string> = {
  connected: "devtools-bg-green-500",
  connecting: "devtools-bg-yellow-500",
  disconnected: "devtools-bg-gray-400",
  errored: "devtools-bg-red-500",
  info: "devtools-bg-blue-500",
  warn: "devtools-bg-yellow-600",
};

function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * Anchored panel with connection internals: live stats (in-flight, buffering,
 * AIMD batch window, reconnects), SharedWorker pooling details, and the
 * connection timeline (state transitions, token refreshes, probes).
 *
 * Interactive controls (toggle button, transport select) are created once and
 * patched in place so they survive the 1-second refresh cycle. Display-only
 * sections (stats grids, timeline) are rebuilt each tick.
 */
export class ConnectionPopover {
  private element: HTMLElement;
  private source: ConnectionInfoSource;
  private onTransportSwitch: ((name: string) => void) | null;
  private open = false;
  private refreshInterval: ReturnType<typeof setInterval> | null = null;
  private outsideClickHandler: ((e: MouseEvent) => void) | null = null;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;
  private anchor: HTMLElement | null = null;

  // Stable interactive elements — survive re-renders.
  private controlsContainer: HTMLElement;
  private toggleBtn: HTMLButtonElement;
  private transportSelect: HTMLSelectElement;
  private contentContainer: HTMLElement;

  // Track previous transport list to avoid rebuilding <option>s needlessly.
  private prevTransports: string[] = [];

  constructor(source: ConnectionInfoSource, onTransportSwitch?: (name: string) => void) {
    this.source = source;
    this.onTransportSwitch = onTransportSwitch ?? null;
    this.element = document.createElement("div");
    this.element.className = "devtools-popover";
    this.element.style.display = "none";

    // Controls: toggle button + transport select (created once, patched in render)
    this.controlsContainer = document.createElement("div");
    this.controlsContainer.className = "devtools-popover-controls";

    this.toggleBtn = document.createElement("button");
    this.toggleBtn.addEventListener("click", () => this.source.toggleConnection());
    this.controlsContainer.append(this.toggleBtn);

    this.transportSelect = document.createElement("select");
    this.transportSelect.className = "devtools-popover-transport-select";
    this.transportSelect.addEventListener("change", (e) => {
      this.onTransportSwitch?.((e.target as HTMLSelectElement).value);
    });
    this.controlsContainer.append(this.transportSelect);

    this.contentContainer = document.createElement("div");

    this.element.append(this.controlsContainer, this.contentContainer);
  }

  toggle(anchor: HTMLElement) {
    if (this.open) {
      this.hide();
    } else {
      this.show(anchor);
    }
  }

  show(anchor: HTMLElement) {
    this.anchor = anchor;
    this.open = true;
    this.element.style.display = "";
    this.position();
    this.render();

    this.refreshInterval = setInterval(() => this.render(), 1000);

    this.outsideClickHandler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!this.element.contains(target) && !this.anchor?.contains(target)) {
        this.hide();
      }
    };
    document.addEventListener("mousedown", this.outsideClickHandler, true);

    this.keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") this.hide();
    };
    document.addEventListener("keydown", this.keyHandler, true);
  }

  hide() {
    this.open = false;
    this.element.style.display = "none";
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
    if (this.outsideClickHandler) {
      document.removeEventListener("mousedown", this.outsideClickHandler, true);
      this.outsideClickHandler = null;
    }
    if (this.keyHandler) {
      document.removeEventListener("keydown", this.keyHandler, true);
      this.keyHandler = null;
    }
  }

  isOpen(): boolean {
    return this.open;
  }

  private position() {
    if (!this.anchor) return;
    const container = this.element.offsetParent as HTMLElement | null;
    const containerRect = (container ?? document.body).getBoundingClientRect();
    const anchorRect = this.anchor.getBoundingClientRect();
    this.element.style.top = `${anchorRect.bottom - containerRect.top + 4}px`;
    this.element.style.right = `${Math.max(4, containerRect.right - anchorRect.right)}px`;
  }

  private render() {
    const state = this.source.getConnectionState();
    const connection = this.source.getConnection();
    const statistics = this.source.getStatistics();
    const diagnostics = connection?.diagnostics;

    this.patchControls(state);
    this.rebuildContent(state, connection, statistics, diagnostics);
  }

  /** Patch the stable controls in place — never destroy/recreate. */
  private patchControls(state: ConnectionStateInfo | null) {
    const isOnline = state?.type === "connected" || state?.type === "connecting";

    this.toggleBtn.textContent = isOnline ? "Go Offline" : "Go Online";
    this.toggleBtn.className = `devtools-popover-toggle ${isOnline ? "devtools-popover-toggle--online" : "devtools-popover-toggle--offline"}`;

    const availableTransports = state?.availableTransports ?? [];
    const showSelect = availableTransports.length > 1 && !!this.onTransportSwitch;

    this.transportSelect.style.display = showSelect ? "" : "none";
    if (!showSelect) return;

    // Only rebuild <option>s when the transport list changes.
    if (!arraysEqual(availableTransports, this.prevTransports)) {
      this.transportSelect.innerHTML = "";
      for (const name of availableTransports) {
        const option = document.createElement("option");
        option.value = name;
        option.textContent = name;
        this.transportSelect.append(option);
      }
      this.prevTransports = availableTransports;
    }

    this.transportSelect.value = state?.transport ?? "";
    this.transportSelect.disabled = !isOnline;
  }

  /** Rebuild display-only sections (stats, worker, timeline). */
  private rebuildContent(
    state: ConnectionStateInfo | null,
    connection: any,
    statistics: Statistics,
    diagnostics: any,
  ) {
    this.contentContainer.innerHTML = "";

    // --- Connection stats ---
    const stats = this.createSection("Connection");
    const grid = document.createElement("div");
    grid.className = "devtools-popover-grid";

    const stateText = state ? state.type : "disconnected";
    this.addStat(grid, "State", `${stateText}${state?.transport ? ` (${state.transport})` : ""}`);

    if (state?.hosting) {
      this.addStat(grid, "Hosting", state.hosting === "worker" ? "SharedWorker" : "main thread");
    }

    const lastConnectedAt = this.source.getLastConnectedAt();
    if (state?.type === "connected" && lastConnectedAt) {
      this.addStat(grid, "Uptime", formatDuration(Date.now() - lastConnectedAt));
    }

    this.addStat(
      grid,
      "Messages",
      `${statistics.sentCount} sent · ${statistics.receivedCount} received`,
    );

    if (typeof connection?.inFlightMessageCount === "number") {
      this.addStat(grid, "In flight", String(connection.inFlightMessageCount));
    }

    if (diagnostics) {
      this.addStat(grid, "Buffered", String(diagnostics.bufferedMessageCount));
      this.addStat(
        grid,
        "Batch window",
        `${diagnostics.batchIntervalMs}ms (max ${formatDuration(diagnostics.maxBatchIntervalMs)})`,
        "AIMD update batching: shrinks on ACKs, doubles on in-flight timeouts",
      );
      this.addStat(
        grid,
        "Reconnects",
        `${diagnostics.reconnectAttempt}/${diagnostics.maxReconnectAttempts}`,
      );
      this.addStat(grid, "Online", diagnostics.online ? "yes" : "no");
    }

    stats.append(grid);
    this.contentContainer.append(stats);

    // --- SharedWorker section ---
    const worker = diagnostics?.worker;
    if (worker) {
      const section = this.createSection("SharedWorker");
      const workerGrid = document.createElement("div");
      workerGrid.className = "devtools-popover-grid";

      this.addStat(
        workerGrid,
        "Tabs",
        `${worker.tabIds.length} sharing this connection`,
        worker.tabIds.join("\n"),
      );
      this.addStat(
        workerGrid,
        "Pooling key",
        worker.connectionKey,
        "Tabs whose options produce the same key share one transport",
      );
      this.addStat(
        workerGrid,
        "Grace period",
        formatDuration(worker.gracePeriodMs),
        "How long the worker keeps the connection alive after the last tab leaves",
      );
      if (typeof connection?.missedHeartbeats === "number") {
        this.addStat(
          workerGrid,
          "Heartbeat",
          connection.missedHeartbeats === 0
            ? "ok"
            : `${connection.missedHeartbeats} missed (worker considered dead after 2)`,
        );
      }

      section.append(workerGrid);
      this.contentContainer.append(section);
    }

    // --- Timeline ---
    const timeline = this.source.getTimeline();
    const section = this.createSection("Timeline");
    const list = document.createElement("div");
    list.className = "devtools-popover-timeline";

    if (timeline.length === 0) {
      const empty = document.createElement("div");
      empty.className = "devtools-popover-empty";
      empty.textContent = "No connection events yet";
      list.append(empty);
    }

    for (let i = timeline.length - 1; i >= 0; i--) {
      const entry = timeline[i];
      const row = document.createElement("div");
      row.className = "devtools-popover-timeline-row";
      if (entry.detail) row.title = entry.detail;

      const time = document.createElement("span");
      time.className = "devtools-popover-timeline-time";
      time.textContent = formatClock(entry.timestamp);
      row.append(time);

      const dot = document.createElement("span");
      dot.className = `devtools-popover-timeline-dot ${TIMELINE_DOT_COLOR[entry.kind]}`;
      row.append(dot);

      const label = document.createElement("span");
      label.className = "devtools-popover-timeline-label";
      label.textContent = entry.label;
      row.append(label);

      const next = timeline[i + 1];
      if (next && entry.kind !== "info" && entry.kind !== "warn") {
        const duration = document.createElement("span");
        duration.className = "devtools-popover-timeline-duration";
        duration.textContent = formatDuration(next.timestamp - entry.timestamp);
        row.append(duration);
      }

      list.append(row);
    }

    section.append(list);
    this.contentContainer.append(section);
  }

  private createSection(title: string): HTMLElement {
    const section = document.createElement("div");
    section.className = "devtools-popover-section";
    const heading = document.createElement("div");
    heading.className = "devtools-popover-section-title";
    heading.textContent = title;
    section.append(heading);
    return section;
  }

  private addStat(grid: HTMLElement, label: string, value: string, tooltip?: string) {
    const labelEl = document.createElement("span");
    labelEl.className = "devtools-popover-stat-label";
    labelEl.textContent = label;
    const valueEl = document.createElement("span");
    valueEl.className = "devtools-popover-stat-value";
    valueEl.textContent = value;
    if (tooltip) {
      labelEl.title = tooltip;
      valueEl.title = tooltip;
    }
    grid.append(labelEl, valueEl);
  }

  getElement(): HTMLElement {
    return this.element;
  }

  destroy() {
    this.hide();
  }
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
