import type { ConnectionStateInfo, ConnectionTimelineEntry, Statistics } from "../types";
import { formatDuration } from "../utils/message-utils";

export type ConnectionInfoSource = {
  getConnectionState(): ConnectionStateInfo | null;
  getConnection(): any;
  getTimeline(): ConnectionTimelineEntry[];
  getStatistics(): Statistics;
  getLastConnectedAt(): number | null;
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
 */
export class ConnectionPopover {
  private element: HTMLElement;
  private source: ConnectionInfoSource;
  private open = false;
  private refreshInterval: ReturnType<typeof setInterval> | null = null;
  private outsideClickHandler: ((e: MouseEvent) => void) | null = null;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;
  private anchor: HTMLElement | null = null;

  constructor(source: ConnectionInfoSource) {
    this.source = source;
    this.element = document.createElement("div");
    this.element.className = "devtools-popover";
    this.element.style.display = "none";
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
    this.element.innerHTML = "";

    const state = this.source.getConnectionState();
    const connection = this.source.getConnection();
    const statistics = this.source.getStatistics();
    const diagnostics = connection?.diagnostics;

    // --- Connection stats ---
    const stats = this.createSection("Connection");
    const grid = document.createElement("div");
    grid.className = "devtools-popover-grid";

    const stateText = state ? state.type : "disconnected";
    this.addStat(grid, "State", `${stateText}${state?.transport ? ` (${state.transport})` : ""}`);

    if (state?.hosting) {
      this.addStat(grid, "Hosting", state.hosting === "worker" ? "SharedWorker" : "main thread");
    }
    if (state?.availableTransports?.length) {
      this.addStat(grid, "Transports", state.availableTransports.join(", "));
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
    this.element.append(stats);

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
      this.element.append(section);
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

      // Duration this state lasted (until the next recorded event)
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
    this.element.append(section);
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
