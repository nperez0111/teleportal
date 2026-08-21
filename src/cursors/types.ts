import type { Awareness } from "y-protocols/awareness";

/** A screen-space cursor coordinate, in CSS pixels. */
export interface CursorPosition {
  x: number;
  y: number;
}

/**
 * A resolved view of one remote peer's cursor, passed to the render/update and
 * interaction hooks. `state` is the peer's full awareness state so custom
 * renderers can read fields beyond name/color.
 */
export interface RemoteCursor {
  /** The peer's awareness client id. */
  clientId: number;
  position: CursorPosition;
  /** Display name, as read by {@link CursorOverlayOptions.getName}. */
  name?: string;
  /** Cursor color, as read by {@link CursorOverlayOptions.getColor}. */
  color?: string;
  /** The peer's complete awareness state. */
  state: Record<string, unknown>;
}

/** Spring tuning for cursor smoothing. All fields are optional and have sensible defaults. */
export interface SpringConfig {
  /** Spring stiffness — higher = snappier pull toward the target. Default `180`. */
  stiffness?: number;
  /** Spring damping — higher = less oscillation. Default `24`. */
  damping?: number;
  /** Snap-to-target once the remaining distance (px) is below this. Default `0.5`. */
  restDelta?: number;
  /** Snap-to-target once the combined per-axis speed is below this. Default `0.5`. */
  restSpeed?: number;
  /**
   * Maximum frame delta, in seconds, fed to the integrator. Guards against huge
   * jumps after a tab switch or long GC pause. Default `0.064` (~2 frames @ 30fps).
   */
  maxTimeStep?: number;
}

/** Options for {@link CursorOverlay}. Only `awareness` is required. */
export interface CursorOverlayOptions {
  /** The Y.js awareness instance whose peers should be rendered. */
  awareness: Awareness;
  /**
   * Element that cursor nodes are appended to. When omitted, the overlay creates
   * a fixed, full-viewport, pointer-events-none layer on `document.body`.
   */
  container?: HTMLElement;
  /**
   * Extract a peer's cursor position from its awareness state, or `null`/`undefined`
   * when the peer has no active cursor. Default: `state.user.cursor`.
   */
  getCursor?: (state: any) => CursorPosition | null | undefined;
  /** Extract a peer's display name. Default: `state.user.name`. */
  getName?: (state: any) => string | undefined;
  /** Extract a peer's cursor color. Default: `state.user.color`. */
  getColor?: (state: any) => string | undefined;
  /**
   * Build the DOM node shown for a cursor. The returned element is placed inside a
   * positioned wrapper owned by the overlay, so it is safe to apply your own
   * transforms (e.g. a hover scale) to it without fighting the smoothing loop.
   * Default: an SVG pointer arrow plus a name label.
   */
  renderCursor?: (cursor: RemoteCursor) => HTMLElement;
  /**
   * Update a previously rendered node when the peer's name/color/state changes.
   * Default: refresh the label text and color.
   */
  updateCursor?: (el: HTMLElement, cursor: RemoteCursor) => void;
  /** Spring tuning for the smoothing animation. */
  spring?: SpringConfig;
  /**
   * Milliseconds a cursor may go without an update before it is hidden and then
   * removed. Default `5000`.
   */
  staleTimeout?: number;
  /**
   * Pixels to shift each cursor so a renderer's visual tip lands on the exact
   * coordinate. Default `2` (matches the built-in arrow).
   */
  tipOffset?: number;
  /** Inject the default stylesheet once, on construction. Default `true`. */
  injectStyles?: boolean;
  /** Called when a rendered cursor is clicked. Enables pointer events on cursors. */
  onCursorClick?: (cursor: RemoteCursor, el: HTMLElement) => void;
  /** Called after a cursor node is created and mounted. */
  onCursorAdd?: (cursor: RemoteCursor, el: HTMLElement) => void;
  /** Called after a cursor node is removed (stale timeout or awareness removal). */
  onCursorRemove?: (clientId: number) => void;
}

/** Options for {@link trackPointer}. Only `awareness` is required. */
export interface TrackPointerOptions {
  /** The awareness instance to publish the local pointer into. */
  awareness: Awareness;
  /**
   * Element (or document) to listen for pointer events on. Default: `document`.
   * Positions are still reported in `clientX`/`clientY` space unless you override
   * {@link TrackPointerOptions.getPosition}.
   */
  target?: Document | HTMLElement;
  /**
   * Map a pointer event to a position, or return `null` to ignore it (e.g. when the
   * pointer is outside a bounded surface). Default: `{ x: clientX, y: clientY }`.
   */
  getPosition?: (event: PointerEvent) => CursorPosition | null;
  /**
   * Write the position (or `null` when the pointer leaves) into awareness.
   * Default: merge `{ cursor }` into the existing `user` field, preserving other
   * fields such as name/color.
   */
  publish?: (awareness: Awareness, position: CursorPosition | null) => void;
  /**
   * Minimum interval between awareness publishes, in milliseconds. Keeps network
   * traffic reasonable — the spring interpolation on the receiving end makes the
   * motion look smooth regardless. Default `50` (~20 updates/s).
   */
  throttleMs?: number;
}
