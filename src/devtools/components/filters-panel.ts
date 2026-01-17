import type { FilterState, ConnectionStateInfo, Statistics } from "../types";
import type { SettingsManager } from "../settings-manager";
import { formatRelativeTime } from "../utils/message-utils";

export class FiltersPanel {
  private element: HTMLElement;
  private settingsManager: SettingsManager;
  private filters: FilterState;
  private connectionState: ConnectionStateInfo | null = null;
  private statistics: Statistics | null = null;
  private availableDocuments: string[] = [];
  private availableMessageTypes: string[] = [];
  private isExpanded = false;
  private searchText = "";
  private searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private timestampInterval: ReturnType<typeof setInterval> | null = null;
  private timestampElement: HTMLElement | null = null;
  private onFiltersChange: (filters: Partial<FilterState>) => void;
  private onClearFilters: () => void;

  constructor(
    settingsManager: SettingsManager,
    onFiltersChange: (filters: Partial<FilterState>) => void,
    onClearFilters: () => void,
  ) {
    this.settingsManager = settingsManager;
    this.filters = settingsManager.getSettings().filters;
    this.searchText = this.filters.searchText;
    this.onFiltersChange = onFiltersChange;
    this.onClearFilters = onClearFilters;

    this.element = document.createElement("div");
    this.element.className =
      "devtools-bg-gray-50 devtools-border-b devtools-border-gray-200";
    this.render();
  }

  update(
    filters: FilterState,
    connectionState: ConnectionStateInfo | null,
    statistics: Statistics | null,
    availableDocuments: string[],
    availableMessageTypes: string[],
  ) {
    this.filters = filters;
    this.connectionState = connectionState;
    this.statistics = statistics;
    this.availableDocuments = availableDocuments;
    this.availableMessageTypes = availableMessageTypes;
    this.render();
  }

  private hasActiveFilters(): boolean {
    return (
      this.filters.documentIds.length > 0 ||
      this.filters.hiddenMessageTypes.length > 0 ||
      this.filters.direction !== "all" ||
      this.filters.searchText.length > 0
    );
  }

  private getConnectionStatusColor(): string {
    if (!this.connectionState) return "devtools-bg-gray-400";
    switch (this.connectionState.type) {
      case "connected": {
        return "devtools-bg-green-500";
      }
      case "connecting": {
        return "devtools-bg-yellow-500";
      }
      case "disconnected": {
        return "devtools-bg-gray-400";
      }
      case "errored": {
        return "devtools-bg-red-500";
      }
      default: {
        return "devtools-bg-gray-400";
      }
    }
  }

  private getConnectionStatusText(): string {
    if (!this.connectionState) return "Disconnected";
    return (
      this.connectionState.type.charAt(0).toUpperCase() +
      this.connectionState.type.slice(1)
    );
  }

  private handleDocumentToggle(docId: string) {
    const newDocIds = this.filters.documentIds.includes(docId)
      ? this.filters.documentIds.filter((id) => id !== docId)
      : [...this.filters.documentIds, docId];
    this.onFiltersChange({ documentIds: newDocIds });
  }

  private handleMessageTypeToggle(type: string) {
    const newHiddenTypes = this.filters.hiddenMessageTypes.includes(type)
      ? this.filters.hiddenMessageTypes.filter((t) => t !== type)
      : [...this.filters.hiddenMessageTypes, type];
    this.onFiltersChange({ hiddenMessageTypes: newHiddenTypes });
  }

  private handleSearchChange(value: string) {
    this.searchText = value;
    if (this.searchDebounceTimer) {
      clearTimeout(this.searchDebounceTimer);
    }
    this.searchDebounceTimer = setTimeout(() => {
      this.onFiltersChange({ searchText: this.searchText });
    }, 300);
  }

  private render() {
    this.element.innerHTML = "";

    // Compact header row - always visible
    const header = document.createElement("div");
    header.className =
      "devtools-flex devtools-items-center devtools-gap-2 devtools-px-2 devtools-py-1.5";

    // Filters toggle button - styled as actual button
    const filtersButton = document.createElement("button");
    filtersButton.className = "devtools-filters-button";

    const arrow = document.createElement("span");
    arrow.className = "devtools-filters-arrow";
    arrow.textContent = this.isExpanded ? "▼" : "▶";
    filtersButton.append(arrow);

    const label = document.createElement("span");
    label.textContent = "Filters";
    filtersButton.append(label);

    if (this.hasActiveFilters()) {
      const indicator = document.createElement("span");
      indicator.className = "devtools-filters-active-indicator";
      indicator.title = "Filters active";
      filtersButton.append(indicator);
    }

    filtersButton.addEventListener("click", () => {
      this.isExpanded = !this.isExpanded;
      this.render();
    });
    header.append(filtersButton);

    // Clear filters button
    if (this.hasActiveFilters()) {
      const clearButton = document.createElement("button");
      clearButton.className =
        "devtools-text-xs devtools-text-blue-600 devtools-hover:underline";
      clearButton.textContent = "Clear";
      clearButton.addEventListener("click", this.onClearFilters);
      header.append(clearButton);
    }

    // Spacer
    const spacer = document.createElement("div");
    spacer.className = "devtools-flex-1";
    header.append(spacer);

    // Status indicators
    const statusContainer = document.createElement("div");
    statusContainer.className =
      "devtools-flex devtools-items-center devtools-gap-3 devtools-text-xs";

    // Connection status
    const connectionStatus = document.createElement("div");
    connectionStatus.className =
      "devtools-flex devtools-items-center devtools-gap-1.5";

    // Clean up old interval
    if (this.timestampInterval) {
      clearInterval(this.timestampInterval);
      this.timestampInterval = null;
    }

    const statusDot = document.createElement("div");
    statusDot.className = `devtools-w-2 devtools-h-2 devtools-rounded-full ${this.getConnectionStatusColor()}`;
    connectionStatus.append(statusDot);
    const statusText = document.createElement("span");
    statusText.className = "devtools-text-gray-700 devtools-font-medium";
    statusText.textContent = this.getConnectionStatusText();
    connectionStatus.append(statusText);
    if (this.connectionState?.transport) {
      const transportText = document.createElement("span");
      transportText.className = "devtools-text-gray-500 devtools-ml-1";
      transportText.textContent = `(${this.connectionState.transport})`;
      connectionStatus.append(transportText);
    }
    if (this.connectionState?.error) {
      const errorText = document.createElement("span");
      errorText.className = "devtools-text-red-600 devtools-ml-1";
      const errorMsg =
        this.connectionState.error.length > 30
          ? this.connectionState.error.slice(0, 30) + "..."
          : this.connectionState.error;
      errorText.textContent = `⚠ ${errorMsg}`;
      errorText.title = this.connectionState.error;
      connectionStatus.append(errorText);
    }
    if (this.connectionState?.timestamp) {
      const timestampText = document.createElement("span");
      timestampText.className =
        "devtools-text-gray-500 devtools-ml-1 devtools-font-mono devtools-text-xs";
      timestampText.textContent = formatRelativeTime(
        this.connectionState.timestamp,
      );
      connectionStatus.append(timestampText);
      this.timestampElement = timestampText;

      // Update timestamp every second
      this.timestampInterval = setInterval(() => {
        if (this.timestampElement && this.connectionState?.timestamp) {
          this.timestampElement.textContent = formatRelativeTime(
            this.connectionState.timestamp,
          );
        }
      }, 1000);
    } else {
      this.timestampElement = null;
    }
    statusContainer.append(connectionStatus);

    // Document count
    if (this.statistics && this.statistics.documentCount > 0) {
      const separator = document.createElement("span");
      separator.className = "devtools-text-gray-400";
      separator.textContent = "•";
      statusContainer.append(separator);
      const docCount = document.createElement("span");
      docCount.className = "devtools-text-gray-600";
      docCount.textContent = `${this.statistics.documentCount} doc${
        this.statistics.documentCount === 1 ? "" : "s"
      }`;
      statusContainer.append(docCount);
    }

    header.append(statusContainer);

    // Message limit input
    const limitContainer = document.createElement("div");
    limitContainer.className =
      "devtools-flex devtools-items-center devtools-gap-2 devtools-text-xs devtools-text-gray-600";
    const limitLabel = document.createElement("span");
    limitLabel.textContent = "Limit:";
    limitContainer.append(limitLabel);
    const limitInput = document.createElement("input");
    limitInput.type = "number";
    limitInput.min = "1";
    limitInput.value = String(this.settingsManager.getSettings().messageLimit);
    limitInput.className = "devtools-input";
    limitInput.style.width = "4rem";
    limitInput.addEventListener("change", (e) => {
      const limit = Number.parseInt((e.target as HTMLInputElement).value, 10);
      if (!isNaN(limit) && limit > 0) {
        this.settingsManager.updateMessageLimit(limit);
      }
    });
    limitContainer.append(limitInput);
    header.append(limitContainer);

    this.element.append(header);

    // Expandable filter content
    if (this.isExpanded) {
      const filterContent = document.createElement("div");
      filterContent.className = "devtools-p-2 devtools-space-y-2";

      // Search input
      const searchContainer = document.createElement("div");
      searchContainer.className =
        "devtools-flex devtools-items-center devtools-gap-2";
      const searchLabel = document.createElement("label");
      searchLabel.className =
        "devtools-text-xs devtools-font-medium devtools-text-gray-700 devtools-whitespace-nowrap";
      searchLabel.textContent = "Search:";
      searchContainer.append(searchLabel);
      const searchInput = document.createElement("input");
      searchInput.type = "text";
      searchInput.value = this.searchText;
      searchInput.placeholder = "Search...";
      searchInput.className = "devtools-input devtools-flex-1";
      searchInput.addEventListener("input", (e) => {
        this.handleSearchChange((e.target as HTMLInputElement).value);
      });
      searchContainer.append(searchInput);
      filterContent.append(searchContainer);

      // Direction select
      const directionContainer = document.createElement("div");
      directionContainer.className =
        "devtools-flex devtools-items-center devtools-gap-2";
      const directionLabel = document.createElement("label");
      directionLabel.className =
        "devtools-text-xs devtools-font-medium devtools-text-gray-700 devtools-whitespace-nowrap";
      directionLabel.textContent = "Direction:";
      directionContainer.append(directionLabel);
      const directionSelect = document.createElement("select");
      directionSelect.className = "devtools-select devtools-flex-1";
      directionSelect.value = this.filters.direction;
      directionSelect.innerHTML = `
        <option value="all">All</option>
        <option value="sent">Sent</option>
        <option value="received">Received</option>
      `;
      directionSelect.addEventListener("change", (e) => {
        this.onFiltersChange({
          direction: (e.target as HTMLSelectElement).value as
            | "all"
            | "sent"
            | "received",
        });
      });
      directionContainer.append(directionSelect);
      filterContent.append(directionContainer);

      // Documents checkboxes
      if (this.availableDocuments.length > 0) {
        const docsContainer = document.createElement("div");
        const docsLabel = document.createElement("label");
        docsLabel.className =
          "devtools-text-xs devtools-font-medium devtools-text-gray-700 devtools-mb-1 devtools-block";
        docsLabel.textContent = `Documents (${this.filters.documentIds.length} selected)`;
        docsContainer.append(docsLabel);
        const docsList = document.createElement("div");
        docsList.className =
          "devtools-max-h-24 devtools-overflow-y-auto devtools-border devtools-border-gray-300 devtools-rounded devtools-bg-white devtools-p-1 devtools-space-y-0.5";
        for (const docId of this.availableDocuments) {
          const docItem = document.createElement("label");
          docItem.className =
            "devtools-flex devtools-items-center devtools-gap-1.5 devtools-text-xs devtools-cursor-pointer devtools-hover:bg-gray-50 devtools-px-1 devtools-py-0.5 devtools-rounded";
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.className = "devtools-checkbox";
          checkbox.checked = this.filters.documentIds.includes(docId);
          checkbox.addEventListener("change", () => {
            this.handleDocumentToggle(docId);
          });
          docItem.append(checkbox);
          const docText = document.createElement("span");
          docText.className =
            "devtools-font-mono devtools-text-gray-900 devtools-truncate";
          docText.textContent = docId;
          docItem.append(docText);
          docsList.append(docItem);
        }
        docsContainer.append(docsList);
        filterContent.append(docsContainer);
      }

      // Message types checkboxes
      if (this.availableMessageTypes.length > 0) {
        const typesContainer = document.createElement("div");
        const typesLabel = document.createElement("label");
        typesLabel.className =
          "devtools-text-xs devtools-font-medium devtools-text-gray-700 devtools-mb-1 devtools-block";
        typesLabel.textContent = `Types (${this.filters.hiddenMessageTypes.length} hidden)`;
        typesContainer.append(typesLabel);
        const typesList = document.createElement("div");
        typesList.className =
          "devtools-max-h-24 devtools-overflow-y-auto devtools-border devtools-border-gray-300 devtools-rounded devtools-bg-white devtools-p-1 devtools-space-y-0.5";
        for (const type of this.availableMessageTypes) {
          const typeItem = document.createElement("label");
          typeItem.className =
            "devtools-flex devtools-items-center devtools-gap-1.5 devtools-text-xs devtools-cursor-pointer devtools-hover:bg-gray-50 devtools-px-1 devtools-py-0.5 devtools-rounded";
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.className = "devtools-checkbox";
          checkbox.checked = !this.filters.hiddenMessageTypes.includes(type);
          checkbox.addEventListener("change", () => {
            this.handleMessageTypeToggle(type);
          });
          typeItem.append(checkbox);
          const typeText = document.createElement("span");
          typeText.className = "devtools-font-mono devtools-text-gray-900";
          typeText.textContent = type;
          typeItem.append(typeText);
          typesList.append(typeItem);
        }
        typesContainer.append(typesList);
        filterContent.append(typesContainer);
      }

      this.element.append(filterContent);
    }
  }

  getElement(): HTMLElement {
    return this.element;
  }

  destroy() {
    if (this.searchDebounceTimer) {
      clearTimeout(this.searchDebounceTimer);
    }
    if (this.timestampInterval) {
      clearInterval(this.timestampInterval);
    }
  }
}
