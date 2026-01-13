import { memo } from "react";
import type { Statistics } from "../types";

interface StatisticsPanelProps {
  statistics: Statistics;
}

export const StatisticsPanel = memo(function StatisticsPanel({
  statistics,
}: StatisticsPanelProps) {
  const { connectionState } = statistics;

  const getConnectionStatusColor = () => {
    if (!connectionState) return "bg-gray-500";
    switch (connectionState.type) {
      case "connected":
        return "bg-green-500";
      case "connecting":
        return "bg-yellow-500";
      case "disconnected":
        return "bg-gray-500";
      case "errored":
        return "bg-red-500";
      default:
        return "bg-gray-500";
    }
  };

  const getConnectionStatusText = () => {
    if (!connectionState) return "Unknown";
    return connectionState.type.charAt(0).toUpperCase() +
      connectionState.type.slice(1);
  };

  return (
    <div className="p-4 space-y-4 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
        Statistics
      </h2>

      <div className="grid grid-cols-2 gap-4">
        <div className="bg-white dark:bg-gray-800 p-3 rounded-lg border border-gray-200 dark:border-gray-700">
          <div className="text-sm text-gray-600 dark:text-gray-400">
            Total Messages
          </div>
          <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {statistics.totalMessages}
          </div>
        </div>

        <div className="bg-white dark:bg-gray-800 p-3 rounded-lg border border-gray-200 dark:border-gray-700">
          <div className="text-sm text-gray-600 dark:text-gray-400">
            Message Rate
          </div>
          <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {statistics.messageRate.toFixed(1)}/s
          </div>
        </div>

        <div className="bg-white dark:bg-gray-800 p-3 rounded-lg border border-gray-200 dark:border-gray-700">
          <div className="text-sm text-gray-600 dark:text-gray-400">
            Sent
          </div>
          <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {statistics.sentCount}
          </div>
        </div>

        <div className="bg-white dark:bg-gray-800 p-3 rounded-lg border border-gray-200 dark:border-gray-700">
          <div className="text-sm text-gray-600 dark:text-gray-400">
            Received
          </div>
          <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {statistics.receivedCount}
          </div>
        </div>

        <div className="bg-white dark:bg-gray-800 p-3 rounded-lg border border-gray-200 dark:border-gray-700">
          <div className="text-sm text-gray-600 dark:text-gray-400">
            Documents
          </div>
          <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {statistics.documentCount}
          </div>
        </div>

        <div className="bg-white dark:bg-gray-800 p-3 rounded-lg border border-gray-200 dark:border-gray-700">
          <div className="text-sm text-gray-600 dark:text-gray-400">
            Connection
          </div>
          <div className="flex items-center gap-2">
            <div
              className={`w-3 h-3 rounded-full ${getConnectionStatusColor()}`}
            />
            <span className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {getConnectionStatusText()}
            </span>
          </div>
          {connectionState?.transport && (
            <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              {connectionState.transport}
            </div>
          )}
        </div>
      </div>

      {Object.keys(statistics.messagesByType).length > 0 && (
        <div className="bg-white dark:bg-gray-800 p-3 rounded-lg border border-gray-200 dark:border-gray-700">
          <div className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">
            Messages by Type
          </div>
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {Object.entries(statistics.messagesByType)
              .sort(([, a], [, b]) => b - a)
              .map(([type, count]) => (
                <div
                  key={type}
                  className="flex justify-between text-sm text-gray-700 dark:text-gray-300"
                >
                  <span className="font-mono">{type}</span>
                  <span className="font-semibold">{count}</span>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
});
