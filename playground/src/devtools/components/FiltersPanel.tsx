import { memo, useState, useEffect } from "react";
import type { FilterState, ConnectionStateInfo, Statistics } from "../types";
import { useDevtoolsSettings } from "../hooks/useDevtoolsSettings";

interface FiltersPanelProps {
  filters: FilterState;
  availableDocuments: string[];
  availableMessageTypes: string[];
  onFiltersChange: (filters: Partial<FilterState>) => void;
  onClearFilters: () => void;
  connectionState: ConnectionStateInfo | null;
  statistics: Statistics;
}

export const FiltersPanel = memo(function FiltersPanel({
  filters,
  availableDocuments,
  availableMessageTypes,
  onFiltersChange,
  onClearFilters,
  connectionState,
  statistics,
}: FiltersPanelProps) {
  const { settings, updateMessageLimit } = useDevtoolsSettings();
  const [isExpanded, setIsExpanded] = useState(false);
  const [searchText, setSearchText] = useState(filters.searchText);
  const [searchDebounceTimer, setSearchDebounceTimer] = useState<ReturnType<
    typeof setTimeout
  > | null>(null);

  useEffect(() => {
    // Debounce search text
    if (searchDebounceTimer) {
      clearTimeout(searchDebounceTimer);
    }
    const timer = setTimeout(() => {
      onFiltersChange({ searchText });
    }, 300);
    setSearchDebounceTimer(timer);

    return () => {
      clearTimeout(timer);
    };
  }, [searchText, onFiltersChange]);

  const handleDocumentToggle = (docId: string) => {
    const newDocIds = filters.documentIds.includes(docId)
      ? filters.documentIds.filter((id) => id !== docId)
      : [...filters.documentIds, docId];
    onFiltersChange({ documentIds: newDocIds });
  };

  const handleMessageTypeToggle = (type: string) => {
    const newHiddenTypes = filters.hiddenMessageTypes.includes(type)
      ? filters.hiddenMessageTypes.filter((t) => t !== type)
      : [...filters.hiddenMessageTypes, type];
    onFiltersChange({ hiddenMessageTypes: newHiddenTypes });
  };

  const hasActiveFilters =
    filters.documentIds.length > 0 ||
    filters.hiddenMessageTypes.length > 0 ||
    filters.direction !== "all" ||
    filters.searchText.length > 0;

  const getConnectionStatusColor = () => {
    if (!connectionState) return "bg-gray-400";
    switch (connectionState.type) {
      case "connected":
        return "bg-green-500";
      case "connecting":
        return "bg-yellow-500";
      case "disconnected":
        return "bg-gray-400";
      case "errored":
        return "bg-red-500";
      default:
        return "bg-gray-400";
    }
  };

  const getConnectionStatusText = () => {
    if (!connectionState) return "Disconnected";
    return (
      connectionState.type.charAt(0).toUpperCase() +
      connectionState.type.slice(1)
    );
  };

  return (
    <div className="bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800">
      {/* Compact header row - always visible */}
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-gray-200 dark:border-gray-800">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="text-xs font-medium text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 px-2 py-1 rounded hover:bg-gray-200 dark:hover:bg-gray-800"
        >
          <span className="inline-flex items-center gap-1.5">
            <span>{isExpanded ? "▼" : "▶"} Filters</span>
            {hasActiveFilters && (
              <span
                className="w-1.5 h-1.5 rounded-full bg-green-500"
                title="Filters active"
              />
            )}
          </span>
        </button>
        {hasActiveFilters && (
          <>
            <button
              onClick={onClearFilters}
              className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
            >
              Clear
            </button>
          </>
        )}
        <div className="flex-1" />

        {/* Status indicators */}
        <div className="flex items-center gap-3 text-xs">
          {/* Connection status */}
          <div className="flex items-center gap-1.5">
            <div
              className={`w-2 h-2 rounded-full ${getConnectionStatusColor()}`}
            />
            <span className="text-gray-700 dark:text-gray-300 font-medium">
              {getConnectionStatusText()}
            </span>
            {connectionState?.transport && (
              <span className="text-gray-500 dark:text-gray-400">
                ({connectionState.transport})
              </span>
            )}
            {connectionState?.error && (
              <span
                className="text-red-600 dark:text-red-400"
                title={connectionState.error}
              >
                ⚠{" "}
                {connectionState.error.length > 30
                  ? connectionState.error.slice(0, 30) + "..."
                  : connectionState.error}
              </span>
            )}
          </div>

          {/* Document count */}
          {statistics.documentCount > 0 && (
            <>
              <span className="text-gray-400 dark:text-gray-500">•</span>
              <span className="text-gray-600 dark:text-gray-400">
                {statistics.documentCount} doc
                {statistics.documentCount !== 1 ? "s" : ""}
              </span>
            </>
          )}
        </div>

        <div className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
          <span>Limit:</span>
          <input
            type="number"
            min="1"
            value={settings.messageLimit}
            onChange={(e) => {
              const limit = parseInt(e.target.value, 10);
              if (!isNaN(limit) && limit > 0) {
                updateMessageLimit(limit);
              }
            }}
            className="w-16 px-1.5 py-0.5 border border-gray-300 dark:border-gray-700 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
      </div>

      {/* Expandable filter content */}
      {isExpanded && (
        <div className="p-2 space-y-2">
          <div className="flex items-center gap-2">
            <label className="text-xs font-medium text-gray-700 dark:text-gray-300 whitespace-nowrap">
              Search:
            </label>
            <input
              type="text"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="Search..."
              className="flex-1 px-2 py-1 text-xs border border-gray-300 dark:border-gray-700 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <div className="flex items-center gap-2">
            <label className="text-xs font-medium text-gray-700 dark:text-gray-300 whitespace-nowrap">
              Direction:
            </label>
            <select
              value={filters.direction}
              onChange={(e) =>
                onFiltersChange({
                  direction: e.target.value as "all" | "sent" | "received",
                })
              }
              className="flex-1 px-2 py-1 text-xs border border-gray-300 dark:border-gray-700 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="all">All</option>
              <option value="sent">Sent</option>
              <option value="received">Received</option>
            </select>
          </div>

          {availableDocuments.length > 0 && (
            <div>
              <label className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-1 block">
                Documents ({filters.documentIds.length} selected)
              </label>
              <div className="max-h-24 overflow-y-auto border border-gray-300 dark:border-gray-700 rounded bg-white dark:bg-gray-800 p-1 space-y-0.5">
                {availableDocuments.map((docId) => (
                  <label
                    key={docId}
                    className="flex items-center gap-1.5 text-xs cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700 px-1 py-0.5 rounded"
                  >
                    <input
                      type="checkbox"
                      checked={filters.documentIds.includes(docId)}
                      onChange={() => handleDocumentToggle(docId)}
                      className="rounded border-gray-300 dark:border-gray-600"
                    />
                    <span className="font-mono text-gray-900 dark:text-gray-100 truncate">
                      {docId}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {availableMessageTypes.length > 0 && (
            <div>
              <label className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-1 block">
                Types ({filters.hiddenMessageTypes.length} hidden)
              </label>
              <div className="max-h-24 overflow-y-auto border border-gray-300 dark:border-gray-700 rounded bg-white dark:bg-gray-800 p-1 space-y-0.5">
                {availableMessageTypes.map((type) => (
                  <label
                    key={type}
                    className="flex items-center gap-1.5 text-xs cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700 px-1 py-0.5 rounded"
                  >
                    <input
                      type="checkbox"
                      checked={!filters.hiddenMessageTypes.includes(type)}
                      onChange={() => handleMessageTypeToggle(type)}
                      className="rounded border-gray-300 dark:border-gray-600"
                    />
                    <span className="font-mono text-gray-900 dark:text-gray-100">
                      {type}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
