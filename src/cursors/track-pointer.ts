import type { Awareness } from "y-protocols/awareness";

import { throttle } from "./throttle";
import type { CursorPosition, TrackPointerOptions } from "./types";

/** Default position selector: raw viewport coordinates. */
function defaultGetPosition(event: PointerEvent): CursorPosition {
  return { x: event.clientX, y: event.clientY };
}

/**
 * Default publisher: merge `{ cursor }` into the local `user` awareness field,
 * preserving any other fields (name, color, …) already set there.
 */
function defaultPublish(awareness: Awareness, position: CursorPosition | null): void {
  const user = (awareness.getLocalState() as { user?: Record<string, unknown> } | null)?.user;
  awareness.setLocalStateField("user", { ...user, cursor: position });
}

/**
 * Publish the local pointer position into awareness so other peers can render it
 * (typically via {@link CursorOverlay}). Publishes are throttled (see
 * {@link TrackPointerOptions.throttleMs}) so fast pointer events don't overwhelm
 * the backend — the receiving spring interpolation keeps motion smooth anyway.
 * The cursor is cleared immediately when the pointer leaves the target.
 *
 * @returns a cleanup function that removes the listeners and clears the cursor.
 */
export function trackPointer(options: TrackPointerOptions): () => void {
  if (typeof document === "undefined") {
    throw new Error("trackPointer requires a DOM (it must run in the browser).");
  }

  const { awareness } = options;
  const target: Document | HTMLElement = options.target ?? document;
  const getPosition = options.getPosition ?? defaultGetPosition;
  const publish = options.publish ?? defaultPublish;
  const throttleMs = options.throttleMs ?? 50;

  const publishThrottled = throttle<CursorPosition>(
    (position) => publish(awareness, position),
    throttleMs,
  );

  const onPointerMove = (event: Event) => {
    const position = getPosition(event as PointerEvent);
    if (!position) return;
    publishThrottled(position);
  };

  const onPointerLeave = () => {
    // Drop any pending move and clear the cursor right away so peers see us leave.
    publishThrottled.cancel();
    publish(awareness, null);
  };

  target.addEventListener("pointermove", onPointerMove);
  target.addEventListener("pointerleave", onPointerLeave);

  return () => {
    publishThrottled.cancel();
    target.removeEventListener("pointermove", onPointerMove);
    target.removeEventListener("pointerleave", onPointerLeave);
    publish(awareness, null);
  };
}
