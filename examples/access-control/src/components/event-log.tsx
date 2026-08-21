import { useEffect, useRef } from "react";

export type LogEntry = {
  id: number;
  timestamp: number;
  message: string;
  type: "info" | "success" | "warning" | "error" | "crypto";
};

const typeStyles: Record<LogEntry["type"], string> = {
  info: "text-slate-500",
  success: "text-emerald-600",
  warning: "text-amber-600",
  error: "text-red-600",
  crypto: "text-violet-600",
};

const typeIcons: Record<LogEntry["type"], string> = {
  info: "ℹ",
  success: "✓",
  warning: "⚠",
  error: "✗",
  crypto: "✷",
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function EventLog({ entries }: { entries: LogEntry[] }) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries.length]);

  return (
    <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
      <div className="px-4 py-2 border-b border-gray-100 bg-gray-50">
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Event Log</h3>
      </div>
      <div className="h-40 overflow-y-auto px-4 py-2 font-mono text-xs space-y-0.5">
        {entries.length === 0 && <p className="text-gray-400 italic">Waiting for events...</p>}
        {entries.map((entry) => (
          <div key={entry.id} className="flex gap-2">
            <span className="text-gray-400 shrink-0">{formatTime(entry.timestamp)}</span>
            <span className={`shrink-0 ${typeStyles[entry.type]}`}>{typeIcons[entry.type]}</span>
            <span className={typeStyles[entry.type]}>{entry.message}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
