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
  private onFiltersChange: (filters: Partial<FilterState>) => void;
  private onClearFilters: () => void;
  private onTransportSwitch: ((name: string) => void) | null;

  // Cached DOM references
  private arrowSpan!: HTMLElement;
  private activeIndicator: HTMLElement | null = null;
  private clearButton: HTMLElement | null = null;
  private statusDot!: HTMLElement;
  private statusText!: HTMLElement;
  private transportContainer!: HTMLElement;
  private errorContainer!: HTMLElement;
  private timestampSpan!: HTMLElement;
  private docCountContainer!: HTMLElement;
  private limitInput!: HTMLInputElement;
  private filterContentContainer!: HTMLElement;
  private headerContainer!: HTMLElement;
  private filtersButtonContainer!: HTMLElement;

  // Track what was last rendered in the expandable section
  private renderedDocs: string[] | null = null;
  private renderedTypes: string[] | null = null;
  private renderedExpanded = false;

  constructor(
    settingsManager: SettingsManager,
    onFiltersChange: (filters: Partial<FilterState>) => void,
    onClearFilters: () => void,
    onTransportSwitch?: (name: string) => void,
  ) {
    this.settingsManager = settingsManager;
    this.filters = settingsManager.getSettings().filters;
    this.searchText = this.filters.searchText;
    this.onFiltersChange = onFiltersChange;
    this.onClearFilters = onClearFilters;
    this.onTransportSwitch = onTransportSwitch ?? null;

    this.element = document.createElement("div");
    this.element.className = "devtools-bg-gray-50 devtools-border-b devtools-border-gray-200";

    this.buildStaticDOM();
    this.patchDynamic();
  }

  private buildStaticDOM() {
    // Header row
    this.headerContainer = document.createElement("div");
    this.headerContainer.className =
      "devtools-flex devtools-items-center devtools-gap-2 devtools-px-2 devtools-py-1.5";

    // Filters button container (button + clear)
    this.filtersButtonContainer = document.createElement("div");
    this.filtersButtonContainer.className = "devtools-flex devtools-items-center devtools-gap-2";

    const filtersButton = document.createElement("button");
    filtersButton.className = "devtools-filters-button";

    this.arrowSpan = document.createElement("span");
    this.arrowSpan.className = "devtools-filters-arrow";
    filtersButton.append(this.arrowSpan);

    const label = document.createElement("span");
    label.textContent = "Filters";
    filtersButton.append(label);

    filtersButton.addEventListener("click", () => {
      this.isExpanded = !this.isExpanded;
      this.patchDynamic();
    });
    this.filtersButtonContainer.append(filtersButton);
    this.headerContainer.append(this.filtersButtonContainer);

    // Spacer
    const spacer = document.createElement("div");
    spacer.className = "devtools-flex-1";
    this.headerContainer.append(spacer);

    // Status container
    const statusContainer = document.createElement("div");
    statusContainer.className =
      "devtools-flex devtools-items-center devtools-gap-3 devtools-text-xs";

    // Connection status
    const connectionStatus = document.createElement("div");
    connectionStatus.className = "devtools-flex devtools-items-center devtools-gap-1.5";

    this.statusDot = document.createElement("div");
    this.statusDot.className =
      "devtools-w-2 devtools-h-2 devtools-rounded-full devtools-bg-gray-400";
    connectionStatus.append(this.statusDot);

    this.statusText = document.createElement("span");
    this.statusText.className = "devtools-text-gray-700 devtools-font-medium";
    this.statusText.textContent = "Disconnected";
    connectionStatus.append(this.statusText);

    this.transportContainer = document.createElement("span");
    connectionStatus.append(this.transportContainer);

    this.errorContainer = document.createElement("span");
    connectionStatus.append(this.errorContainer);

    this.timestampSpan = document.createElement("span");
    this.timestampSpan.className =
      "devtools-text-gray-500 devtools-ml-1 devtools-font-mono devtools-text-xs";
    connectionStatus.append(this.timestampSpan);

    statusContainer.append(connectionStatus);

    // Doc count
    this.docCountContainer = document.createElement("span");
    statusContainer.append(this.docCountContainer);

    this.headerContainer.append(statusContainer);

    // Message limit
    const limitContainer = document.createElement("div");
    limitContainer.className =
      "devtools-flex devtools-items-center devtools-gap-2 devtools-text-xs devtools-text-gray-600";
    const limitLabel = document.createElement("span");
    limitLabel.textContent = "Limit:";
    limitContainer.append(limitLabel);
    this.limitInput = document.createElement("input");
    this.limitInput.type = "number";
    this.limitInput.min = "1";
    this.limitInput.value = String(this.settingsManager.getSettings().messageLimit);
    this.limitInput.className = "devtools-input";
    this.limitInput.style.width = "4rem";
    this.limitInput.addEventListener("change", (e) => {
      const limit = Number.parseInt((e.target as HTMLInputElement).value, 10);
      if (!isNaN(limit) && limit > 0) {
        this.settingsManager.updateMessageLimit(limit);
      }
    });
    limitContainer.append(this.limitInput);
    this.headerContainer.append(limitContainer);

    this.element.append(this.headerContainer);

    // Expandable content container
    this.filterContentContainer = document.createElement("div");
    this.element.append(this.filterContentContainer);

    // Start timestamp interval once
    this.timestampInterval = setInterval(() => {
      if (this.connectionState?.timestamp) {
        this.timestampSpan.textContent = formatRelativeTime(this.connectionState.timestamp);
      }
    }, 1000);
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
    this.patchDynamic();
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
      case "connected":
        return "devtools-bg-green-500";
      case "connecting":
        return "devtools-bg-yellow-500";
      case "disconnected":
        return "devtools-bg-gray-400";
      case "errored":
        return "devtools-bg-red-500";
      default:
        return "devtools-bg-gray-400";
    }
  }

  private getConnectionStatusText(): string {
    if (!this.connectionState) return "Disconnected";
    return this.connectionState.type.charAt(0).toUpperCase() + this.connectionState.type.slice(1);
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

  private patchDynamic() {
    // Arrow
    this.arrowSpan.textContent = this.isExpanded ? "▼" : "▶";

    // Active indicator on the filters button
    const hasActive = this.hasActiveFilters();
    const filtersButton = this.filtersButtonContainer.firstElementChild as HTMLElement;

    if (hasActive && !this.activeIndicator) {
      this.activeIndicator = document.createElement("span");
      this.activeIndicator.className = "devtools-filters-active-indicator";
      this.activeIndicator.title = "Filters active";
      filtersButton.append(this.activeIndicator);
    } else if (!hasActive && this.activeIndicator) {
      this.activeIndicator.remove();
      this.activeIndicator = null;
    }

    // Clear button
    if (hasActive && !this.clearButton) {
      this.clearButton = document.createElement("button");
      this.clearButton.className =
        "devtools-text-xs devtools-text-blue-600 devtools-hover:underline";
      this.clearButton.textContent = "Clear";
      this.clearButton.addEventListener("click", this.onClearFilters);
      this.filtersButtonContainer.append(this.clearButton);
    } else if (!hasActive && this.clearButton) {
      this.clearButton.remove();
      this.clearButton = null;
    }

    // Status dot
    this.statusDot.className = `devtools-w-2 devtools-h-2 devtools-rounded-full ${this.getConnectionStatusColor()}`;
    this.statusText.textContent = this.getConnectionStatusText();

    // Transport
    this.transportContainer.innerHTML = "";
    if (this.connectionState?.transport || this.connectionState?.availableTransports?.length) {
      const availableTransports = this.connectionState.availableTransports ?? [];

      if (availableTransports.length > 1 && this.onTransportSwitch) {
        const transportSelect = document.createElement("select");
        transportSelect.className = "devtools-select devtools-transport-select";

        for (const name of availableTransports) {
          const option = document.createElement("option");
          option.value = name;
          option.textContent = name;
          option.selected = name === this.connectionState.transport;
          transportSelect.append(option);
        }

        transportSelect.disabled = this.connectionState.type !== "connected";
        transportSelect.addEventListener("change", (e) => {
          const selected = (e.target as HTMLSelectElement).value;
          this.onTransportSwitch!(selected);
        });
        this.transportContainer.append(transportSelect);
      } else if (this.connectionState.transport) {
        const transportText = document.createElement("span");
        transportText.className = "devtools-text-gray-500 devtools-ml-1";
        transportText.textContent = `(${this.connectionState.transport})`;
        this.transportContainer.append(transportText);
      }
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
    if (this.connectionState?.timestamp) {
      this.timestampSpan.textContent = formatRelativeTime(this.connectionState.timestamp);
    } else {
      this.timestampSpan.textContent = "";
    }

    // Doc count
    this.docCountContainer.innerHTML = "";
    if (this.statistics && this.statistics.documentCount > 0) {
      const separator = document.createElement("span");
      separator.className = "devtools-text-gray-400";
      separator.textContent = "•";
      this.docCountContainer.append(separator);
      const docCount = document.createElement("span");
      docCount.className = "devtools-text-gray-600";
      docCount.textContent = `${this.statistics.documentCount} doc${
        this.statistics.documentCount === 1 ? "" : "s"
      }`;
      this.docCountContainer.append(docCount);
    }

    // Limit input — only update if not focused
    if (document.activeElement !== this.limitInput) {
      this.limitInput.value = String(this.settingsManager.getSettings().messageLimit);
    }

    // Expandable filter content — only rebuild when expansion state or data changes
    const docsChanged = this.availableDocuments !== this.renderedDocs;
    const typesChanged = this.availableMessageTypes !== this.renderedTypes;
    const expandedChanged = this.isExpanded !== this.renderedExpanded;

    if (expandedChanged || (this.isExpanded && (docsChanged || typesChanged))) {
      this.renderFilterContent();
      this.renderedDocs = this.availableDocuments;
      this.renderedTypes = this.availableMessageTypes;
      this.renderedExpanded = this.isExpanded;
    } else if (this.isExpanded) {
      this.patchFilterCheckboxes();
    }
  }

  private renderFilterContent() {
    this.filterContentContainer.innerHTML = "";

    if (!this.isExpanded) return;

    const filterContent = document.createElement("div");
    filterContent.className = "devtools-p-2 devtools-space-y-2";

    // Search input
    const searchContainer = document.createElement("div");
    searchContainer.className = "devtools-flex devtools-items-center devtools-gap-2";
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
    directionContainer.className = "devtools-flex devtools-items-center devtools-gap-2";
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
        direction: (e.target as HTMLSelectElement).value as "all" | "sent" | "received",
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
        checkbox.dataset.docId = docId;
        checkbox.addEventListener("change", () => {
          this.handleDocumentToggle(docId);
        });
        docItem.append(checkbox);
        const docText = document.createElement("span");
        docText.className = "devtools-font-mono devtools-text-gray-900 devtools-truncate";
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
        checkbox.dataset.msgType = type;
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

    this.filterContentContainer.append(filterContent);
  }

  private patchFilterCheckboxes() {
    // Update checkbox states without rebuilding DOM
    const checkboxes =
      this.filterContentContainer.querySelectorAll<HTMLInputElement>("input[type=checkbox]");
    for (const cb of checkboxes) {
      if (cb.dataset.docId) {
        cb.checked = this.filters.documentIds.includes(cb.dataset.docId);
      } else if (cb.dataset.msgType) {
        cb.checked = !this.filters.hiddenMessageTypes.includes(cb.dataset.msgType);
      }
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
