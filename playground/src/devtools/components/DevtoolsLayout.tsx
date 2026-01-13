import { useState } from "react";
import { StatisticsPanel } from "./StatisticsPanel";
import { MessageList } from "./MessageList";
import { MessageInspector } from "./MessageInspector";
import { FiltersPanel } from "./FiltersPanel";
import type { DevtoolsMessage, Statistics, FilterState } from "../types";
import { useMessageFilters } from "../hooks/useMessageFilters";

interface DevtoolsLayoutProps {
  messages: DevtoolsMessage[];
  statistics: Statistics;
  onClearMessages: () => void;
}

export function DevtoolsLayout({
  messages,
  statistics,
  onClearMessages,
}: DevtoolsLayoutProps) {
  const [selectedMessage, setSelectedMessage] =
    useState<DevtoolsMessage | null>(null);

  const {
    filters,
    filteredMessages,
    updateFilters,
    clearFilters,
    availableDocuments,
    availableMessageTypes,
  } = useMessageFilters(messages);

  return (
    <div className="h-full flex flex-col bg-gray-100 dark:bg-gray-950">
      {/* Compact top bar with filters (collapsible) */}
      <div className="flex-shrink-0 border-b border-gray-200 dark:border-gray-800">
        <FiltersPanel
          filters={filters}
          availableDocuments={availableDocuments}
          availableMessageTypes={availableMessageTypes}
          onFiltersChange={updateFilters}
          onClearFilters={clearFilters}
        />
      </div>

      {/* Main content area: Message List | Inspector */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Message List (takes most space) */}
        <div className="flex-1 min-w-0 border-r border-gray-200 dark:border-gray-800">
          <MessageList
            messages={filteredMessages}
            selectedMessageId={selectedMessage?.id || null}
            onSelectMessage={setSelectedMessage}
          />
        </div>

        {/* Right: Message Inspector */}
        <div className="w-96 flex-shrink-0">
          <MessageInspector message={selectedMessage} />
        </div>
      </div>
    </div>
  );
}
