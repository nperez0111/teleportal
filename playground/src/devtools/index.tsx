import { useEffect } from "react";
import { useRef } from "react";
import { teleportalEventClient } from "teleportal/providers";

export function TeleportalDevtoolsPanelReact() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    teleportalEventClient.onAllPluginEvents((event) => {
      console.log(event);
    });
  }, []);

  return (
    <div ref={containerRef} style={{ width: "100%", height: "100%" }}>
      Hello world
    </div>
  );
}
