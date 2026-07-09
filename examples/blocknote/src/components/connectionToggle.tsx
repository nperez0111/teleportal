import { useConnectionState } from "../utils/useConnectionState";
import type { PlaygroundProvider } from "../utils/providers";

function WifiIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.141 0M1.394 9.393c5.857-5.858 15.355-5.858 21.213 0"
      />
    </svg>
  );
}

function AirplaneIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M12 19V5m0 0l-4 4m4-4l4 4M5 21h14"
      />
    </svg>
  );
}

function StateDot({ type }: { type: string }) {
  const colors: Record<string, string> = {
    connected: "bg-green-500",
    connecting: "bg-yellow-500 animate-pulse",
    disconnected: "bg-gray-400",
    errored: "bg-red-500",
  };
  return <span className={`w-2 h-2 rounded-full shrink-0 ${colors[type] ?? "bg-gray-400"}`} />;
}

function stateLabel(type: string): string {
  if (type === "connected") return "Online";
  if (type === "connecting") return "Syncing…";
  return "Offline";
}

export function ConnectionToggle({ provider }: { provider: PlaygroundProvider | null }) {
  const { state, bufferedMessageCount, isConnected, isConnecting, toggle } =
    useConnectionState(provider);

  if (!provider) return null;

  const isOnline = isConnected || isConnecting;

  return (
    <button
      onClick={toggle}
      className={`relative px-3 py-2 text-sm font-medium border rounded-lg transition-colors flex items-center gap-2 whitespace-nowrap ${
        isOnline
          ? "text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700"
          : "text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 border-amber-300 dark:border-amber-700"
      }`}
      title={isOnline ? "Go offline (airplane mode)" : "Go online"}
      type="button"
    >
      <StateDot type={state.type} />
      {isOnline ? (
        <WifiIcon className={`w-4 h-4 shrink-0 ${isConnecting ? "animate-pulse" : ""}`} />
      ) : (
        <AirplaneIcon className="w-4 h-4 shrink-0" />
      )}
      <span className="hidden md:inline">{stateLabel(state.type)}</span>

      {bufferedMessageCount > 0 && !isOnline && (
        <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full bg-amber-500 text-white text-[10px] font-bold leading-none">
          {bufferedMessageCount > 99 ? "99+" : bufferedMessageCount}
        </span>
      )}
    </button>
  );
}
