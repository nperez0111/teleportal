import { useState, useEffect } from "react";
import type { DevtoolsSettings } from "../types";

const STORAGE_KEY = "teleportal-devtools-message-limit";
const DEFAULT_MESSAGE_LIMIT = 200;

export function useDevtoolsSettings() {
  const [settings, setSettings] = useState<DevtoolsSettings>(() => {
    // Load from localStorage on init
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const limit = parseInt(stored, 10);
        if (!isNaN(limit) && limit > 0) {
          return { messageLimit: limit };
        }
      }
    } catch (error) {
      // localStorage might not be available
      console.warn("Failed to load devtools settings:", error);
    }
    return { messageLimit: DEFAULT_MESSAGE_LIMIT };
  });

  useEffect(() => {
    // Save to localStorage when settings change
    try {
      localStorage.setItem(STORAGE_KEY, String(settings.messageLimit));
    } catch (error) {
      console.warn("Failed to save devtools settings:", error);
    }
  }, [settings.messageLimit]);

  const updateMessageLimit = (limit: number) => {
    if (limit > 0) {
      setSettings({ messageLimit: limit });
    }
  };

  return {
    settings,
    updateMessageLimit,
  };
}
