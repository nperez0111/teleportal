import { useState, useMemo } from "react";
import type { DevtoolsMessage, FilterState } from "../types";
import { getMessageTypeLabel } from "../utils/message-utils";

export function useMessageFilters(messages: DevtoolsMessage[]) {
  const [filters, setFilters] = useState<FilterState>({
    documentIds: [],
    messageTypes: [],
    direction: "all",
    searchText: "",
  });

  const filteredMessages = useMemo(() => {
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
      if (filters.messageTypes.length > 0) {
        const type = getMessageTypeLabel(msg.message);
        if (!filters.messageTypes.includes(type)) {
          return false;
        }
      }

      // Direction filter
      if (filters.direction !== "all" && msg.direction !== filters.direction) {
        return false;
      }

      // Search text filter
      if (filters.searchText) {
        const searchLower = filters.searchText.toLowerCase();
        const payloadStr = JSON.stringify(msg.message).toLowerCase();
        const docStr = (msg.document || "").toLowerCase();
        if (!payloadStr.includes(searchLower) && !docStr.includes(searchLower)) {
          return false;
        }
      }

      return true;
    });
  }, [messages, filters]);

  const updateFilters = (updates: Partial<FilterState>) => {
    setFilters((prev) => ({ ...prev, ...updates }));
  };

  const clearFilters = () => {
    setFilters({
      documentIds: [],
      messageTypes: [],
      direction: "all",
      searchText: "",
    });
  };

  // Get unique document IDs from messages
  const availableDocuments = useMemo(() => {
    const docs = new Set<string>();
    messages.forEach((msg) => {
      if (msg.document) {
        docs.add(msg.document);
      }
    });
    return Array.from(docs).sort();
  }, [messages]);

  // Get unique message types from messages (excluding ACKs)
  const availableMessageTypes = useMemo(() => {
    const types = new Set<string>();
    messages.forEach((msg) => {
      if (msg.message.type !== "ack") {
        types.add(getMessageTypeLabel(msg.message));
      }
    });
    return Array.from(types).sort();
  }, [messages]);

  return {
    filters,
    filteredMessages,
    updateFilters,
    clearFilters,
    availableDocuments,
    availableMessageTypes,
  };
}
