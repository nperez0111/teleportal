/**
 * `teleportal/cursors` — dependency-free, spring-smoothed multiplayer cursors
 * driven by Y.js awareness.
 *
 * - {@link CursorOverlay} renders and smoothly animates remote peers' cursors.
 * - {@link trackPointer} publishes the local pointer into awareness.
 *
 * Both are fully configurable (data shape, rendering, spring tuning) and ship
 * with sensible defaults for the common `state.user = { name, color, cursor }`
 * convention.
 */
export { CursorOverlay } from "./overlay";
export { trackPointer } from "./track-pointer";
export {
  CURSOR_ARROW_SVG,
  defaultGetColor,
  defaultGetCursor,
  defaultGetName,
  defaultRenderCursor,
  defaultUpdateCursor,
} from "./render";
export { CURSOR_STYLES, injectCursorStyles } from "./styles";
export { isSpringAtRest, stepSpring, type SpringParams, type SpringState } from "./spring";
export { throttle, type Throttled } from "./throttle";
export type {
  CursorOverlayOptions,
  CursorPosition,
  RemoteCursor,
  SpringConfig,
  TrackPointerOptions,
} from "./types";
