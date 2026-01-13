import { memo, useRef, useEffect } from "react";
import type { DevtoolsMessage } from "../types";
import { MessageItem } from "./MessageItem";

interface MessageListProps {
  messages: DevtoolsMessage[];
  selectedMessageId: string | null;
  onSelectMessage: (message: DevtoolsMessage) => void;
}

export const MessageList = memo(function MessageList({
  messages,
  selectedMessageId,
  onSelectMessage,
}: MessageListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);

  useEffect(() => {
    if (shouldAutoScrollRef.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages]);

  const handleScroll = () => {
    if (listRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = listRef.current;
      // Auto-scroll if user is near bottom (within 100px)
      shouldAutoScrollRef.current = scrollHeight - scrollTop - clientHeight < 100;
    }
  };

  return (
    <div className="flex flex-col h-full bg-white dark:bg-gray-950">
      <div className="px-2 py-1 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          Messages ({messages.length})
        </h2>
      </div>
      <div
        ref={listRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto"
      >
        {messages.length === 0 ? (
          <div className="p-4 text-center text-xs text-gray-500 dark:text-gray-400">
            No messages to display
          </div>
        ) : (
          messages.map((message) => (
            <MessageItem
              key={message.id}
              message={message}
              isSelected={selectedMessageId === message.id}
              onClick={() => onSelectMessage(message)}
            />
          ))
        )}
      </div>
    </div>
  );
});
