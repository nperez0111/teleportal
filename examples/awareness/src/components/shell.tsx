import { useEffect, useRef, useState } from "react";

import { Provider } from "teleportal/providers";
import { createTokenManager, DocumentAccessBuilder } from "teleportal/token";
import { createBoopRpc, type BoopRpc } from "../boop-client";
import type { Awareness } from "y-protocols/awareness";

const ADJECTIVES = [
  "Swift",
  "Calm",
  "Bold",
  "Bright",
  "Keen",
  "Brave",
  "Sly",
  "Wise",
  "Warm",
  "Cool",
  "Quick",
  "Lazy",
  "Tiny",
  "Grand",
  "Witty",
  "Chill",
];
const ANIMALS = [
  "Penguin",
  "Otter",
  "Fox",
  "Owl",
  "Panda",
  "Raven",
  "Wolf",
  "Bear",
  "Hawk",
  "Lynx",
  "Crane",
  "Hare",
  "Seal",
  "Deer",
  "Finch",
  "Koala",
];
const COLORS = [
  "#30bced",
  "#6eeb83",
  "#ffbc42",
  "#ee6352",
  "#9ac2c9",
  "#e056a0",
  "#8acb88",
  "#1be7ff",
  "#f7b32b",
  "#a06cd5",
];

function generateIdentity() {
  const stored = localStorage.getItem("teleportal-awareness-identity");
  if (stored) return JSON.parse(stored);
  const name = `${ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]} ${ANIMALS[Math.floor(Math.random() * ANIMALS.length)]}`;
  const color = COLORS[Math.floor(Math.random() * COLORS.length)];
  const identity = { name, color };
  localStorage.setItem("teleportal-awareness-identity", JSON.stringify(identity));
  return identity;
}

const tokenManager = createTokenManager({
  secret: "awareness-demo-secret",
  expiresIn: 3600,
  issuer: "awareness-demo",
});

type PeerState = {
  awarenessId: number;
  name: string;
  color: string;
  cursor: { x: number; y: number } | null;
};

export default function Shell() {
  const [provider, setProvider] = useState<Provider | null>(null);
  const [peers, setPeers] = useState<PeerState[]>([]);
  const [boopCount, setBoopCount] = useState(0);
  const [boopFlash, setBoopFlash] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const canvasRef = useRef<HTMLDivElement>(null);
  const boopRpcRef = useRef<BoopRpc | null>(null);

  useEffect(() => {
    const identity = generateIdentity();

    (async () => {
      const token = await tokenManager.createToken(
        identity.name,
        "awareness",
        new DocumentAccessBuilder().admin("*").build(),
      );

      const p = await Provider.create({
        url: `${new URL("./", window.location.href).href}?token=${token}`,
        document: "awareness-demo",
        encryptionKey: false,
        rpc: { boop: createBoopRpc },
      });

      p.awareness.setLocalStateField("user", {
        name: identity.name,
        color: identity.color,
        cursor: null,
      });

      boopRpcRef.current = p.rpc.boop as BoopRpc;
      boopRpcRef.current.onBooped((fromId) => {
        setBoopCount((c) => c + 1);
        const states = p.awareness.getStates();
        const fromState = states.get(fromId) as { user?: { name?: string } } | undefined;
        const fromName = fromState?.user?.name ?? "Someone";
        setBoopFlash(fromName);
        setTimeout(() => setBoopFlash(null), 2000);
      });

      setProvider(p);
      setIsLoading(false);

      const updatePeers = () => {
        const states = p.awareness.getStates();
        const peerList: PeerState[] = [];
        states.forEach((state: any, id: number) => {
          if (id === p.awareness.clientID) return;
          if (!state.user) return;
          peerList.push({
            awarenessId: id,
            name: state.user.name ?? "Anonymous",
            color: state.user.color ?? "#888",
            cursor: state.user.cursor ?? null,
          });
        });
        setPeers(peerList);
      };

      p.awareness.on("change", updatePeers);
      return () => p.awareness.off("change", updatePeers);
    })();
  }, []);

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!provider || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    provider.awareness.setLocalStateField("user", {
      ...((provider.awareness.getLocalState() as any)?.user ?? {}),
      cursor: { x, y },
    });
  };

  const handleMouseLeave = () => {
    if (!provider) return;
    provider.awareness.setLocalStateField("user", {
      ...((provider.awareness.getLocalState() as any)?.user ?? {}),
      cursor: null,
    });
  };

  const handleBoop = (targetId: number) => {
    boopRpcRef.current?.send(targetId);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen text-lg text-zinc-400">
        Connecting...
      </div>
    );
  }

  const identity = generateIdentity();

  return (
    <div className="flex h-screen bg-[#0a0a0f]">
      {/* Cursor canvas */}
      <div
        ref={canvasRef}
        className="flex-1 relative overflow-hidden"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        style={{
          backgroundImage: "radial-gradient(circle, rgba(255,255,255,0.03) 1px, transparent 1px)",
          backgroundSize: "24px 24px",
        }}
      >
        {/* Remote cursors */}
        {peers.map((peer) =>
          peer.cursor ? (
            <div
              key={peer.awarenessId}
              className="absolute transition-all duration-75 ease-out cursor-pointer"
              style={{
                left: `${peer.cursor.x}%`,
                top: `${peer.cursor.y}%`,
                transform: "translate(-2px, -2px)",
              }}
              onClick={() => handleBoop(peer.awarenessId)}
              title={`Click to boop ${peer.name}`}
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 20 20"
                fill="none"
                style={{ filter: `drop-shadow(0 0 4px ${peer.color}40)` }}
              >
                <path
                  d="M5.65 1.45L1.27 15.59L6.89 12.02L10.55 18.01L12.84 16.69L9.18 10.7L15.38 10.17L5.65 1.45Z"
                  fill={peer.color}
                  stroke="#000"
                  strokeWidth="0.5"
                />
              </svg>
              <span
                className="absolute left-5 top-0 text-xs font-medium px-1.5 py-0.5 rounded whitespace-nowrap"
                style={{
                  backgroundColor: peer.color,
                  color: "#000",
                }}
              >
                {peer.name}
              </span>
            </div>
          ) : null,
        )}

        {/* Boop flash overlay */}
        {boopFlash && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none animate-pulse">
            <div className="bg-white/10 backdrop-blur-sm rounded-2xl px-8 py-4 text-xl font-bold">
              {boopFlash} booped you!
            </div>
          </div>
        )}

        {/* Center instructions */}
        {peers.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-zinc-500 gap-2">
            <p className="text-lg">Move your cursor around</p>
            <p className="text-sm">Open another tab to see live cursors</p>
          </div>
        )}
      </div>

      {/* Sidebar */}
      <div className="w-72 border-l border-zinc-800 bg-zinc-900/50 p-4 flex flex-col gap-4">
        {/* Your identity */}
        <div>
          <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">You</h3>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full" style={{ backgroundColor: identity.color }} />
            <span className="text-sm font-medium">{identity.name}</span>
          </div>
        </div>

        {/* Online users */}
        <div>
          <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">
            Online ({peers.length + 1})
          </h3>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2 text-sm">
              <div
                className="w-2.5 h-2.5 rounded-full"
                style={{ backgroundColor: identity.color }}
              />
              <span className="text-zinc-300">{identity.name}</span>
              <span className="text-zinc-600 text-xs">(you)</span>
            </div>
            {peers.map((peer) => (
              <div key={peer.awarenessId} className="flex items-center gap-2 text-sm group">
                <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: peer.color }} />
                <span className="text-zinc-300 flex-1">{peer.name}</span>
                <button
                  className="opacity-0 group-hover:opacity-100 text-xs text-zinc-500 hover:text-white transition-opacity"
                  onClick={() => handleBoop(peer.awarenessId)}
                >
                  boop
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Boop stats */}
        <div className="mt-auto">
          <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">
            Boops Received
          </h3>
          <div className="text-3xl font-bold tabular-nums">{boopCount}</div>
        </div>
      </div>
    </div>
  );
}
