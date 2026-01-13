import { useState } from "react";
import { useEffect, useRef } from "react";
import {
  createTeleportalDevtools,
  getDevtoolsState,
} from "teleportal/devtools";

export function TeleportalDevtoolsPanelReact() {
  const containerRef = useRef<HTMLDivElement>(null);
  const devtoolsRef = useRef<HTMLElement | null>(null);
  const [state] = useState(() => getDevtoolsState());

  useEffect(() => {
    if (!containerRef.current) return;

    // Create the devtools element
    const devtoolsElement = createTeleportalDevtools(state);
    containerRef.current.appendChild(devtoolsElement);
    devtoolsRef.current = devtoolsElement;

    // Cleanup on unmount
    return () => {
      if (devtoolsRef.current) {
        const cleanup = (devtoolsRef.current as any)
          .__teleportalDevtoolsCleanup;
        if (cleanup) {
          cleanup();
        }
        if (
          containerRef.current &&
          devtoolsRef.current.parentNode === containerRef.current
        ) {
          containerRef.current.removeChild(devtoolsRef.current);
        }
      }
    };
  }, []);

  return <div ref={containerRef} style={{ height: "100%", width: "100%" }} />;
}
