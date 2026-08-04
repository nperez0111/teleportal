import { useEffect, useRef, useState } from "react";
import { createTeleportalDevtools, getDevtoolsState } from "teleportal/devtools";

/**
 * React wrapper around the imperative TelePortal devtools.
 *
 * `createTeleportalDevtools` returns a raw `HTMLElement` (it is not a React
 * component), so we mount it into a container `div` on effect and tear it down
 * on unmount. The devtools discover all TelePortal traffic automatically via
 * the global `teleportalEventClient` event bus — there is nothing to wire up as
 * long as the provider is created in the same JS context.
 */
export function TeleportalDevtoolsPanelReact() {
  const containerRef = useRef<HTMLDivElement>(null);
  const devtoolsRef = useRef<HTMLElement | null>(null);
  const [state] = useState(() => getDevtoolsState());

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const devtoolsElement = createTeleportalDevtools(state);
    container.appendChild(devtoolsElement);
    devtoolsRef.current = devtoolsElement;

    return () => {
      const element = devtoolsRef.current;
      if (!element) return;
      const cleanup = (
        element as HTMLElement & {
          __teleportalDevtoolsCleanup?: () => void;
        }
      ).__teleportalDevtoolsCleanup;
      cleanup?.();
      if (element.parentNode === container) {
        container.removeChild(element);
      }
      devtoolsRef.current = null;
    };
  }, [state]);

  return <div ref={containerRef} style={{ height: "100%", width: "100%" }} />;
}
