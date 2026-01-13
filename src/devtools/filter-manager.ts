import type { DevtoolsMessage } from "./types";
import { getMessageTypeLabel } from "./utils/message-utils";
import type { SettingsManager } from "./settings-manager";

export class FilterManager {
  private settingsManager: SettingsManager;
  private listeners = new Set<() => void>();

  constructor(settingsManager: SettingsManager) {
    this.settingsManager = settingsManager;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emitChange() {
    this.listeners.forEach((l) => l());
  }

  getFilters() {
    return this.settingsManager.getSettings().filters;
  }

  getFilteredMessages(messages: DevtoolsMessage[]): DevtoolsMessage[] {
    const filters = this.getFilters();

    return messages.filter((msg) => {
      // Filter out ACK messages - they shouldn't appear in the list
      if (msg.message.type === "ack") {
        return false;
      }

      // Document filter
      if (
        filters.documentIds.length > 0 &&
        msg.document &&
        !filters.documentIds.includes(msg.document)
      ) {
        return false;
      }

      // Message type filter
      const type = getMessageTypeLabel(msg.message);
      if (filters.hiddenMessageTypes.includes(type)) return false;

      // Direction filter
      if (filters.direction !== "all" && msg.direction !== filters.direction) {
        return false;
      }

      // Search text filter
      if (filters.searchText) {
        const searchLower = filters.searchText.toLowerCase();
        const payloadStr = JSON.stringify(msg.message).toLowerCase();
        const docStr = (msg.document || "").toLowerCase();
        if (
          !payloadStr.includes(searchLower) &&
          !docStr.includes(searchLower)
        ) {
          return false;
        }
      }

      return true;
    });
  }

  getAvailableDocuments(messages: DevtoolsMessage[]): string[] {
    const docs = new Set<string>();
    messages.forEach((msg) => {
      if (msg.document) {
        docs.add(msg.document);
      }
    });
    return Array.from(docs).sort();
  }

  getAvailableMessageTypes(messages: DevtoolsMessage[]): string[] {
    const types = new Set<string>();
    messages.forEach((msg) => {
      if (msg.message.type !== "ack") {
        types.add(getMessageTypeLabel(msg.message));
      }
    });
    return Array.from(types).sort();
  }

  updateFilters(updates: Partial<typeof this.getFilters>) {
    this.settingsManager.updateFilters(updates);
    this.emitChange();
  }

  clearFilters() {
    this.settingsManager.clearFilters();
    this.emitChange();
  }
}
