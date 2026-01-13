import { memo, useState } from "react";
import type { DevtoolsMessage } from "../types";
import { formatMessagePayload, formatTimestamp } from "../utils/message-utils";

interface MessageInspectorProps {
  message: DevtoolsMessage | null;
}

export const MessageInspector = memo(function MessageInspector({
  message,
}: MessageInspectorProps) {
  const [copied, setCopied] = useState(false);
  const [showAckDetails, setShowAckDetails] = useState(false);

  if (!message) {
    return (
      <div className="h-full bg-white dark:bg-gray-950 flex items-center justify-center">
        <div className="text-gray-500 dark:text-gray-400">
          Select a message to inspect
        </div>
      </div>
    );
  }

  const handleCopy = async () => {
    try {
      const payload = formatMessagePayload(message.message);
      await navigator.clipboard.writeText(payload);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error("Failed to copy:", error);
    }
  };

  const payload = formatMessagePayload(message.message);

  return (
    <div className="h-full flex flex-col bg-white dark:bg-gray-950">
      <div className="px-2 py-1 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            Inspector
          </h2>
          <button
            onClick={handleCopy}
            className="px-2 py-0.5 text-xs bg-blue-500 hover:bg-blue-600 text-white rounded transition-colors"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        <div>
          <h3 className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
            Metadata
          </h3>
          <div className="bg-gray-50 dark:bg-gray-900 p-1.5 rounded space-y-1 text-xs">
            <div className="flex justify-between">
              <span className="text-gray-600 dark:text-gray-400">ID:</span>
              <span className="font-mono text-gray-900 dark:text-gray-100 text-xs">
                {message.id.slice(0, 16)}...
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600 dark:text-gray-400">Direction:</span>
              <span className="text-gray-900 dark:text-gray-100">
                {message.direction}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600 dark:text-gray-400">Document:</span>
              <span className="font-mono text-gray-900 dark:text-gray-100 truncate max-w-[200px]">
                {message.document || "N/A"}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600 dark:text-gray-400">Time:</span>
              <span className="text-gray-900 dark:text-gray-100">
                {formatTimestamp(message.timestamp)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600 dark:text-gray-400">Encrypted:</span>
              <span className="text-gray-900 dark:text-gray-100">
                {message.message.encrypted ? "Yes" : "No"}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600 dark:text-gray-400">Type:</span>
              <span className="font-mono text-gray-900 dark:text-gray-100">
                {message.message.type}
              </span>
            </div>
            {message.ackedBy && (
              <div className="flex justify-between items-center">
                <span className="text-gray-600 dark:text-gray-400">ACK'd by:</span>
                <div className="flex items-center gap-1">
                  <span className="font-mono text-green-600 dark:text-green-400 text-xs">
                    {message.ackedBy.ackMessageId.slice(0, 12)}...
                  </span>
                  <button
                    onClick={() => setShowAckDetails(!showAckDetails)}
                    className="text-xs text-blue-600 dark:text-blue-400 hover:underline px-1"
                  >
                    {showAckDetails ? "▼" : "▶"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {message.ackedBy && showAckDetails && (
          <div>
            <h3 className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
              ACK Message
            </h3>
            <pre className="bg-gray-50 dark:bg-gray-900 p-1.5 rounded overflow-x-auto text-xs font-mono text-gray-900 dark:text-gray-100 border border-gray-200 dark:border-gray-800 max-h-32 overflow-y-auto">
              {formatMessagePayload(message.ackedBy.ackMessage)}
            </pre>
          </div>
        )}

        <div>
          <h3 className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
            Payload
          </h3>
          <pre className="bg-gray-50 dark:bg-gray-900 p-1.5 rounded overflow-x-auto text-xs font-mono text-gray-900 dark:text-gray-100 border border-gray-200 dark:border-gray-800 max-h-[60vh] overflow-y-auto">
            {payload}
          </pre>
        </div>
      </div>
    </div>
  );
});
