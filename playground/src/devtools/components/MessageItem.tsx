import { memo } from "react";
import type { DevtoolsMessage } from "../types";
import {
  getMessageTypeLabel,
  getMessageTypeColor,
  formatRelativeTime,
  formatTimestamp,
} from "../utils/message-utils";

interface MessageItemProps {
  message: DevtoolsMessage;
  isSelected: boolean;
  onClick: () => void;
}

export const MessageItem = memo(function MessageItem({
  message,
  isSelected,
  onClick,
}: MessageItemProps) {
  const typeLabel = getMessageTypeLabel(message.message);
  const typeColor = getMessageTypeColor(message.message);

  // Get description text
  const getDescription = () => {
    if (message.message.type === "doc") {
      if (message.message.payload.type === "update") return "Update";
      if (message.message.payload.type === "sync-step-1") return "Sync-1";
      if (message.message.payload.type === "sync-step-2") return "Sync-2";
      if (message.message.payload.type === "sync-done") return "Sync Done";
      return message.message.payload.type;
    }
    if (message.message.type === "awareness") return "Awareness";
    if (message.message.type === "file") {
      return message.message.payload.type === "file-upload"
        ? "Upload"
        : message.message.payload.type === "file-download"
          ? "Download"
          : "Part";
    }
    return message.message.type;
  };

  return (
    <div
      onClick={onClick}
      className={`
        px-2 py-1.5 border-b border-gray-200 dark:border-gray-700 cursor-pointer
        hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors text-xs
        ${isSelected ? "bg-blue-50 dark:bg-blue-900/20 border-l-2 border-l-blue-500 dark:border-l-blue-400" : ""}
      `}
    >
      <div className="flex items-center gap-2">
        {/* Direction - fixed width */}
        <div className="w-4 flex-shrink-0 text-sm text-center">
          {message.direction === "sent" ? "→" : "←"}
        </div>

        {/* Type badge - fixed width */}
        <div
          className={`${typeColor} text-white px-1.5 py-0.5 rounded text-xs font-semibold flex-shrink-0 w-32 text-center truncate`}
          title={typeLabel}
        >
          {typeLabel}
        </div>

        {/* ACK indicator - fixed width */}
        <div className="w-4 flex-shrink-0 text-center">
          {message.ackedBy ? (
            <span
              className="text-green-600 dark:text-green-400"
              title="Acknowledged"
            >
              ✓
            </span>
          ) : (
            <span
              className="text-gray-500 dark:text-gray-500"
              title="Not acknowledged"
            >
              ✗
            </span>
          )}
        </div>

        {/* Description - flexible */}
        <div className="min-w-[60px] flex-1 text-gray-700 dark:text-gray-300 truncate">
          {message.document && (
            <span className="font-mono text-gray-600 dark:text-gray-400 truncate block">
              {message.document}
            </span>
          )}
        </div>

        {/* Timestamp - fixed width */}
        <div className="w-16 flex-shrink-0 text-right">
          <span className="text-gray-500 dark:text-gray-500 text-[10px]">
            {formatTimestamp(message.timestamp)}
          </span>
        </div>
      </div>
    </div>
  );
});
