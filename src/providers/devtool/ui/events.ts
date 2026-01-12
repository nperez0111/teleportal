import type { FilterConfig, PanelState } from "../types.js";

/**
 * Event handlers for the devtool UI
 */
export class DevtoolEventHandlers {
  private container: HTMLElement;
  private onStateChange: (state: Partial<PanelState>) => void;
  private onAction: (action: string, data?: any) => void;

  constructor(
    container: HTMLElement,
    onStateChange: (state: Partial<PanelState>) => void,
    onAction: (action: string, data?: any) => void,
  ) {
    this.container = container;
    this.onStateChange = onStateChange;
    this.onAction = onAction;
  }

  /**
   * Attach all event listeners using event delegation
   */
  attach(): void {
    // Search input
    const searchInput = this.container.querySelector("#tp-search-input");
    if (searchInput) {
      searchInput.addEventListener("input", (e) => {
        const target = e.target as HTMLInputElement;
        this.onStateChange({
          filters: {
            ...this.getCurrentFilters(),
            search: target.value,
          } as FilterConfig,
        });
      });
    }

    // Direction filter buttons
    this.container.querySelectorAll("[data-action='filter-direction']").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const target = e.target as HTMLElement;
        const direction = target.getAttribute("data-direction") as "all" | "sent" | "received";
        this.onStateChange({
          filters: {
            ...this.getCurrentFilters(),
            direction,
          } as FilterConfig,
        });
      });
    });

    // Document filter
    const documentFilter = this.container.querySelector("#tp-document-filter");
    if (documentFilter) {
      documentFilter.addEventListener("change", (e) => {
        const target = e.target as HTMLSelectElement;
        const filters = this.getCurrentFilters();
        if (target.value) {
          filters.documentIds = new Set([target.value]);
        } else {
          filters.documentIds = new Set();
        }
        this.onStateChange({ filters });
      });
    }

    // Type filter
    const typeFilter = this.container.querySelector("#tp-type-filter");
    if (typeFilter) {
      typeFilter.addEventListener("change", (e) => {
        const target = e.target as HTMLSelectElement;
        const filters = this.getCurrentFilters();
        if (target.value) {
          filters.messageTypes = new Set([target.value]);
        } else {
          filters.messageTypes = new Set();
        }
        this.onStateChange({ filters });
      });
    }

    // Message selection
    this.container.querySelectorAll("[data-action='select-message']").forEach((item) => {
      item.addEventListener("click", (e) => {
        const target = e.currentTarget as HTMLElement;
        const messageId = target.getAttribute("data-message-id");
        if (messageId) {
          this.onStateChange({ selectedMessageId: messageId });
        }
      });
    });

    // Close detail button
    const closeDetail = this.container.querySelector("#tp-close-detail");
    if (closeDetail) {
      closeDetail.addEventListener("click", () => {
        this.onStateChange({ selectedMessageId: null });
      });
    }

    // Theme toggle
    const themeToggle = this.container.querySelector("#tp-theme-toggle");
    if (themeToggle) {
      themeToggle.addEventListener("click", () => {
        const currentTheme = themeToggle.getAttribute("data-theme");
        let newTheme: "light" | "dark" | "system" = "system";
        if (currentTheme === "system") {
          newTheme = "dark";
        } else if (currentTheme === "dark") {
          newTheme = "light";
        } else {
          newTheme = "system";
        }
        this.onStateChange({ theme: newTheme });
      });
    }

    // Clear logs
    const clearLogs = this.container.querySelector("#tp-clear-logs");
    if (clearLogs) {
      clearLogs.addEventListener("click", () => {
        this.onAction("clear-logs");
      });
    }

    // Export logs
    const exportLogs = this.container.querySelector("#tp-export-logs");
    if (exportLogs) {
      exportLogs.addEventListener("click", () => {
        this.onAction("export-logs");
      });
    }
  }

  /**
   * Detach all event listeners
   */
  detach(): void {
    // Event listeners are automatically cleaned up when elements are removed
    // But we can add specific cleanup if needed
  }

  /**
   * Get current filter state from DOM (for initial state)
   */
  private getCurrentFilters(): FilterConfig {
    // This is a fallback - in practice, state should be managed by the panel
    return {
      direction: "all",
      messageTypes: new Set(),
      documentIds: new Set(),
      search: "",
    };
  }

  /**
   * Re-attach listeners after DOM update
   * Call this after re-rendering
   */
  reattach(): void {
    this.detach();
    this.attach();
  }
}
