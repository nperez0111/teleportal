import type { DevtoolsMessage, FilterState } from "./types";
import { getMessageTypeLabel } from "./utils/message-utils";
import type { SettingsManager } from "./settings-manager";

const searchCache = new WeakMap<DevtoolsMessage, string>();

function getSearchString(msg: DevtoolsMessage): string {
  let cached = searchCache.get(msg);
  if (cached === undefined) {
    cached = JSON.stringify(msg.message).toLowerCase();
    searchCache.set(msg, cached);
  }
  return cached;
}

export class FilterManager {
  private settingsManager: SettingsManager;
  private listeners = new Set<() => void>();
  private pendingNotify = false;

  private cachedFiltered: DevtoolsMessage[] | null = null;
  private cachedFilteredKey: string | null = null;
  private cachedDocs: string[] | null = null;
  private cachedDocsGen = -1;
  private cachedDocsLen = -1;
  private cachedTypes: string[] | null = null;
  private cachedTypesGen = -1;
  private cachedTypesLen = -1;

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
    if (this.pendingNotify) return;
    this.pendingNotify = true;
    queueMicrotask(() => {
      this.pendingNotify = false;
      this.listeners.forEach((l) => l());
    });
  }

  getFilters() {
    return this.settingsManager.getSettings().filters;
  }

  getFilteredMessages(messages: DevtoolsMessage[], generation: number): DevtoolsMessage[] {
    const filters = this.getFilters();
    const key = `${generation}:${filters.direction}:${filters.searchText}:${filters.documentIds.join(",")}:${filters.hiddenMessageTypes.join(",")}`;

    if (this.cachedFilteredKey === key && this.cachedFiltered) {
      return this.cachedFiltered;
    }

    const result = messages.filter((msg) => {
      if (msg.message.type === "ack") {
        return false;
      }

      if (
        filters.documentIds.length > 0 &&
        msg.document &&
        !filters.documentIds.includes(msg.document)
      ) {
        return false;
      }

      const type = getMessageTypeLabel(msg.message);
      if (filters.hiddenMessageTypes.includes(type)) return false;

      if (filters.direction !== "all" && msg.direction !== filters.direction) {
        return false;
      }

      if (filters.searchText) {
        const searchLower = filters.searchText.toLowerCase();
        const payloadStr = getSearchString(msg);
        const docStr = (msg.document || "").toLowerCase();
        if (!payloadStr.includes(searchLower) && !docStr.includes(searchLower)) {
          return false;
        }
      }

      return true;
    });

    this.cachedFiltered = result;
    this.cachedFilteredKey = key;
    return result;
  }

  getAvailableDocuments(messages: DevtoolsMessage[], generation: number): string[] {
    if (
      this.cachedDocs &&
      this.cachedDocsGen === generation &&
      this.cachedDocsLen === messages.length
    ) {
      return this.cachedDocs;
    }

    const docs = new Set<string>();
    for (const msg of messages) {
      if (msg.document) {
        docs.add(msg.document);
      }
    }
    const result = Array.from(docs).sort();
    this.cachedDocs = result;
    this.cachedDocsGen = generation;
    this.cachedDocsLen = messages.length;
    return result;
  }

  getAvailableMessageTypes(messages: DevtoolsMessage[], generation: number): string[] {
    if (
      this.cachedTypes &&
      this.cachedTypesGen === generation &&
      this.cachedTypesLen === messages.length
    ) {
      return this.cachedTypes;
    }

    const types = new Set<string>();
    for (const msg of messages) {
      if (msg.message.type !== "ack") {
        types.add(getMessageTypeLabel(msg.message));
      }
    }
    const result = Array.from(types).sort();
    this.cachedTypes = result;
    this.cachedTypesGen = generation;
    this.cachedTypesLen = messages.length;
    return result;
  }

  updateFilters(updates: Partial<FilterState>) {
    this.settingsManager.updateFilters(updates);
    this.cachedFiltered = null;
    this.cachedFilteredKey = null;
    this.emitChange();
  }

  clearFilters() {
    this.settingsManager.clearFilters();
    this.cachedFiltered = null;
    this.cachedFilteredKey = null;
    this.emitChange();
  }
}
