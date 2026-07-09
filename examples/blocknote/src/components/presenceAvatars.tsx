import { usePresence, type Peer } from "../utils/usePresence";
import { getIdentity, colorForUser } from "../utils/identity";
import type { PlaygroundProvider } from "../utils/providers";

const MAX_VISIBLE = 4;

function Avatar({
  label,
  color,
  title,
  dot,
}: {
  label: string;
  color: string;
  title: string;
  dot?: "green";
}) {
  return (
    <div
      className="relative w-8 h-8 rounded-full border-2 border-white dark:border-gray-950 flex items-center justify-center text-xs font-semibold text-white shrink-0 select-none"
      style={{ backgroundColor: color, animation: "avatar-pop 0.2s ease-out" }}
      title={title}
    >
      {label}
      {dot && (
        <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-green-500 border-2 border-white dark:border-gray-950" />
      )}
    </div>
  );
}

function OverflowBubble({ count }: { count: number }) {
  return (
    <div
      className="w-8 h-8 rounded-full border-2 border-white dark:border-gray-950 bg-gray-200 dark:bg-gray-700 flex items-center justify-center text-xs font-semibold text-gray-600 dark:text-gray-300 shrink-0 select-none"
      title={`${count} more peer${count > 1 ? "s" : ""}`}
    >
      +{count}
    </div>
  );
}

export function PresenceAvatars({ provider }: { provider: PlaygroundProvider | null }) {
  const peers = usePresence(provider);
  const identity = getIdentity();

  const visible = peers.slice(0, MAX_VISIBLE - 1);
  const overflow = peers.length - visible.length;

  return (
    <div className="flex items-center -space-x-2">
      <Avatar
        label={identity.name.charAt(0).toUpperCase()}
        color={identity.color}
        title={`You (${identity.name})`}
        dot="green"
      />
      {visible.map((peer: Peer) => (
        <Avatar
          key={peer.awarenessId}
          label={peer.userId.charAt(0).toUpperCase()}
          color={colorForUser(peer.userId)}
          title={peer.userId}
        />
      ))}
      {overflow > 0 && <OverflowBubble count={overflow} />}
    </div>
  );
}
