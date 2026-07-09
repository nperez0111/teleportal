import { useEffect, useRef, useState } from "react";
import type { PlaygroundProvider } from "./providers";
import type { PresenceEvent } from "teleportal/providers";

export type Peer = PresenceEvent;

export function usePresence(provider: PlaygroundProvider | null): Peer[] {
  const [peers, setPeers] = useState<Peer[]>([]);
  const mapRef = useRef(new Map<number, Peer>());

  useEffect(() => {
    if (!provider) {
      setPeers([]);
      return;
    }

    const map = mapRef.current;
    map.clear();

    const offJoin = provider.on("peer-join", (peer: PresenceEvent) => {
      console.log("[awareness] peer-join", {
        awarenessId: peer.awarenessId,
        clientId: peer.clientId,
        userId: peer.userId,
        data: peer.data,
        totalPeers: map.size + 1,
      });
      map.set(peer.awarenessId, peer);
      setPeers([...map.values()]);
    });

    const offLeave = provider.on("peer-leave", (peer: PresenceEvent) => {
      console.log("[awareness] peer-leave", {
        awarenessId: peer.awarenessId,
        clientId: peer.clientId,
        userId: peer.userId,
        data: peer.data,
        totalPeers: map.size - 1,
      });
      map.delete(peer.awarenessId);
      setPeers([...map.values()]);
    });

    return () => {
      offJoin();
      offLeave();
      map.clear();
      setPeers([]);
    };
  }, [provider]);

  return peers;
}
