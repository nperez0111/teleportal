import { useEffect, useRef } from "react";
import { Provider } from "teleportal/providers";

export function TeleportalDevtoolsPanelReact({
  provider,
}: {
  provider: Provider<any>;
}) {
  const devtoolContainerRef = useRef<HTMLDivElement>(null);
  const devtoolRef = useRef<any>(null);

  useEffect(() => {
    if (!provider || !devtoolContainerRef.current) return;

    // Enable the devtool with optional configuration
    const devtool = provider.enableDevtool({
      maxMessages: 200, // Maximum number of messages to keep in memory
      maxSnapshots: 50, // Maximum number of snapshots to keep
      captureSnapshots: true, // Whether to capture before/after snapshots
      trackSubdocs: true, // Whether to track subdocuments separately
      theme: "system", // "light" | "dark" | "system"
    });

    devtoolRef.current = devtool;

    // Mount the devtool to a container element
    devtool.mount(devtoolContainerRef.current);

    // Cleanup on unmount
    return () => {
      if (devtoolRef.current) {
        devtoolRef.current.unmount();
      }
    };
  }, [provider]);

  return (
    <div ref={devtoolContainerRef} style={{ width: "100%", height: "100%" }} />
  );
}
