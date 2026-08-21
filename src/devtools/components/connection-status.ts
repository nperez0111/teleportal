import type { ConnectionStateInfo } from "../types";
import { formatRelativeTime } from "../utils/message-utils";

/**
 * The always-visible connection readout in the header bar: status dot, state
 * text, hosting badge, transport label, error, and a relative timestamp.
 * Transport switching and offline toggle live in the ConnectionPopover.
 */
export class ConnectionStatus {
  private element: HTMLElement;
  private connectionState: ConnectionStateInfo | null = null;
  private timestampInterval: ReturnType<typeof setInterval> | null = null;

  private statusDot!: HTMLElement;
  private statusText!: HTMLElement;
  private modeContainer!: HTMLElement;
  private transportContainer!: HTMLElement;
  private errorContainer!: HTMLElement;
  private timestampSpan!: HTMLElement;

  constructor() {
    this.element = document.createElement("div");
    this.element.className =
      "devtools-connection-status devtools-flex devtools-items-center devtools-gap-1.5 devtools-text-xs";

    this.statusDot = document.createElement("div");
    this.statusDot.className =
      "devtools-w-2 devtools-h-2 devtools-rounded-full devtools-bg-gray-400";
    this.element.append(this.statusDot);

    this.statusText = document.createElement("span");
    this.statusText.className = "devtools-text-gray-700 devtools-font-medium";
    this.statusText.textContent = "Disconnected";
    this.element.append(this.statusText);

    this.modeContainer = document.createElement("span");
    this.element.append(this.modeContainer);

    this.transportContainer = document.createElement("span");
    this.element.append(this.transportContainer);

    this.errorContainer = document.createElement("span");
    this.element.append(this.errorContainer);

    this.timestampSpan = document.createElement("span");
    this.timestampSpan.className =
      "devtools-text-gray-500 devtools-ml-1 devtools-font-mono devtools-text-xs";
    this.element.append(this.timestampSpan);

    this.timestampInterval = setInterval(() => {
      if (this.connectionState?.timestamp) {
        this.timestampSpan.textContent = formatRelativeTime(this.connectionState.timestamp);
      }
    }, 1000);
  }

  update(connectionState: ConnectionStateInfo | null) {
    this.connectionState = connectionState;
    this.patch();
  }

  private getStatusColor(): string {
    switch (this.connectionState?.type) {
      case "connected":
        return "devtools-bg-green-500";
      case "connecting":
        return "devtools-bg-yellow-500";
      case "errored":
        return "devtools-bg-red-500";
      default:
        return "devtools-bg-gray-400";
    }
  }

  private patch() {
    this.statusDot.className = `devtools-w-2 devtools-h-2 devtools-rounded-full ${this.getStatusColor()}`;
    const type = this.connectionState?.type ?? "disconnected";
    this.statusText.textContent = type.charAt(0).toUpperCase() + type.slice(1);

    // Hosting badge
    this.modeContainer.innerHTML = "";
    if (this.connectionState?.hosting) {
      const badge = document.createElement("span");
      badge.className = "devtools-text-gray-500 devtools-ml-1";
      badge.textContent = this.connectionState.hosting === "worker" ? "[worker]" : "[direct]";
      badge.title =
        this.connectionState.hosting === "worker"
          ? "Connection runs in a SharedWorker (shared across tabs)"
          : "Connection runs in the main thread";
      this.modeContainer.append(badge);
    }

    // Transport (read-only label — switching is in the popover)
    this.transportContainer.innerHTML = "";
    if (this.connectionState?.transport) {
      const transportText = document.createElement("span");
      transportText.className = "devtools-text-gray-500 devtools-ml-1";
      transportText.textContent = `(${this.connectionState.transport})`;
      this.transportContainer.append(transportText);
    }

    // Error
    this.errorContainer.innerHTML = "";
    if (this.connectionState?.error) {
      const errorText = document.createElement("span");
      errorText.className = "devtools-text-red-600 devtools-ml-1";
      const errorMsg =
        this.connectionState.error.length > 30
          ? this.connectionState.error.slice(0, 30) + "..."
          : this.connectionState.error;
      errorText.textContent = `⚠ ${errorMsg}`;
      errorText.title = this.connectionState.error;
      this.errorContainer.append(errorText);
    }

    // Timestamp
    this.timestampSpan.textContent = this.connectionState?.timestamp
      ? formatRelativeTime(this.connectionState.timestamp)
      : "";
  }

  getElement(): HTMLElement {
    return this.element;
  }

  destroy() {
    if (this.timestampInterval) {
      clearInterval(this.timestampInterval);
      this.timestampInterval = null;
    }
  }
}
