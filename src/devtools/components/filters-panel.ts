import type { FilterState } from "../types";
import type { SettingsManager } from "../settings-manager";

/**
 * The Messages tab's filter row: collapsible search/direction/document/type
 * filters plus the message limit. Connection status lives in the header bar
 * (see ConnectionStatus), not here.
 */
export class FiltersPanel {
  private element: HTMLElement;
  private settingsManager: SettingsManager;
  private filters: FilterState;
  private availableDocuments: string[] = [];
  private availableMessageTypes: string[] = [];
  private isExpanded = false;
  private searchText = "";
  private searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private onFiltersChange: (filters: Partial<FilterState>) => void;
  private onClearFilters: () => void;

  // Cached DOM references
  private arrowSpan!: HTMLElement;
  private activeIndicator: HTMLElement | null = null;
  private clearButton: HTMLElement | null = null;
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
  ) {
    this.settingsManager = settingsManager;
    this.filters = settingsManager.getSettings().filters;
    this.searchText = this.filters.searchText;
    this.onFiltersChange = onFiltersChange;
    this.onClearFilters = onClearFilters;

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
  }

  update(filters: FilterState, availableDocuments: string[], availableMessageTypes: string[]) {
    this.filters = filters;
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
  }
}
