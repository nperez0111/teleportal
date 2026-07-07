import { useCallback, useEffect, useRef, useState } from "react";
import type { PlaygroundProvider } from "./providers";
import type { ConnectionState } from "teleportal/providers";

export interface ConnectionInfo {
  state: ConnectionState;
  bufferedMessageCount: number;
  isConnected: boolean;
  isConnecting: boolean;
  isDisconnected: boolean;
  isErrored: boolean;
  toggle: () => void;
}

const DEFAULT: ConnectionInfo = {
  state: { type: "disconnected" },
  bufferedMessageCount: 0,
  isConnected: false,
  isConnecting: false,
  isDisconnected: true,
  isErrored: false,
  toggle: () => {},
};

function deriveFlags(state: ConnectionState) {
  return {
    isConnected: state.type === "connected",
    isConnecting: state.type === "connecting",
    isDisconnected: state.type === "disconnected",
    isErrored: state.type === "errored",
  };
}

export function useConnectionState(provider: PlaygroundProvider | null): ConnectionInfo {
  const [state, setState] = useState<ConnectionState>(
    () => provider?.connection.state ?? { type: "disconnected" },
  );
  const [bufferedMessageCount, setBufferedMessageCount] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval>>();

  useEffect(() => {
    if (!provider) {
      setState({ type: "disconnected" });
      setBufferedMessageCount(0);
      return;
    }

    const conn = provider.connection;
    setState(conn.state);
    setBufferedMessageCount(conn.diagnostics.bufferedMessageCount);

    const offUpdate = conn.on("update", (next: ConnectionState) => {
      setState(next);
      setBufferedMessageCount(conn.diagnostics.bufferedMessageCount);
    });

    pollRef.current = setInterval(() => {
      setBufferedMessageCount(conn.diagnostics.bufferedMessageCount);
    }, 1000);

    return () => {
      offUpdate();
      clearInterval(pollRef.current);
    };
  }, [provider]);

  const toggle = useCallback(() => {
    if (!provider) return;
    const conn = provider.connection;
    if (conn.state.type === "connected" || conn.state.type === "connecting") {
      conn.disconnect();
    } else {
      conn.connect();
    }
  }, [provider]);

  if (!provider) return DEFAULT;

  return {
    state,
    bufferedMessageCount,
    ...deriveFlags(state),
    toggle,
  };
}
