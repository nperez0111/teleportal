import type { DevtoolsSettings, FilterState } from "./types";

const STORAGE_KEY = "teleportal-devtools-settings";
// Back-compat: previous versions stored only the limit as a string.
const LEGACY_LIMIT_KEY = "teleportal-devtools-message-limit";
const DEFAULT_MESSAGE_LIMIT = 200;

const DEFAULT_FILTERS: FilterState = {
  documentIds: [],
  hiddenMessageTypes: [],
  direction: "all",
  searchText: "",
};

function loadSettings(): DevtoolsSettings {
  const defaults: DevtoolsSettings = {
    messageLimit: DEFAULT_MESSAGE_LIMIT,
    filters: DEFAULT_FILTERS,
  };

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<DevtoolsSettings> | null;
      if (parsed && typeof parsed === "object") {
        return {
          messageLimit:
            typeof parsed.messageLimit === "number" && parsed.messageLimit > 0
              ? parsed.messageLimit
              : defaults.messageLimit,
          filters: {
            ...DEFAULT_FILTERS,
            ...(parsed.filters ?? {}),
          },
        };
      }
    }

    // Back-compat: previous versions stored only the limit as a string.
    const legacy = localStorage.getItem(LEGACY_LIMIT_KEY);
    if (legacy) {
      const limit = parseInt(legacy, 10);
      if (!isNaN(limit) && limit > 0) {
        return { ...defaults, messageLimit: limit };
      }
    }
  } catch (error) {
    // localStorage might not be available / JSON might be invalid
    console.warn("Failed to load devtools settings:", error);
  }

  return defaults;
}

function saveSettings(settings: DevtoolsSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    // Keep writing legacy key so older code (or other tabs) still see it.
    localStorage.setItem(LEGACY_LIMIT_KEY, String(settings.messageLimit));
  } catch (error) {
    console.warn("Failed to save devtools settings:", error);
  }
}

export class SettingsManager {
  private settings: DevtoolsSettings;
  private listeners = new Set<() => void>();

  constructor() {
    this.settings = loadSettings();
  }

  getSettings(): DevtoolsSettings {
    return this.settings;
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

  updateMessageLimit(limit: number) {
    if (limit > 0) {
      this.settings = { ...this.settings, messageLimit: limit };
      saveSettings(this.settings);
      this.emitChange();
    }
  }

  updateFilters(updates: Partial<FilterState>) {
    this.settings = {
      ...this.settings,
      filters: { ...this.settings.filters, ...updates },
    };
    saveSettings(this.settings);
    this.emitChange();
  }

  clearFilters() {
    this.settings = {
      ...this.settings,
      filters: DEFAULT_FILTERS,
    };
    saveSettings(this.settings);
    this.emitChange();
  }
}
