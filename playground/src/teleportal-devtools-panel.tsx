import { useEffect, useRef } from "react";
import type { TeleportalDevtoolsPanel } from "teleportal/devtools";

interface TeleportalDevtoolsPanelReactProps {
  panel: TeleportalDevtoolsPanel;
}

export function TeleportalDevtoolsPanelReact({
  panel,
}: TeleportalDevtoolsPanelReactProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    panel.mount(containerRef.current);

    return () => {
      panel.unmount();
    };
  }, [panel]);

  return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
}
