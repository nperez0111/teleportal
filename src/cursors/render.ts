import type { CursorPosition, RemoteCursor } from "./types";

/**
 * Default pointer arrow. Its fill reads `--tp-cursor-color` so a single CSS
 * variable recolors the whole cursor. The tip sits near the top-left of the
 * 20×20 box, aligned to the coordinate via `tipOffset`.
 */
export const CURSOR_ARROW_SVG = `<svg class="tp-cursor-arrow" width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M5.65 1.45L1.27 15.59L6.89 12.02L10.55 18.01L12.84 16.69L9.18 10.7L15.38 10.17L5.65 1.45Z" fill="var(--tp-cursor-color)" stroke="#000" stroke-width="0.5"/></svg>`;

const DEFAULT_COLOR = "#888";

/** Apply a cursor's color + name onto the built-in pointer node. */
function applyCursorInfo(el: HTMLElement, cursor: RemoteCursor): void {
  const color = cursor.color ?? DEFAULT_COLOR;
  el.style.setProperty("--tp-cursor-color", color);
  const label = el.querySelector<HTMLElement>(".tp-cursor-label");
  if (label) {
    label.textContent = cursor.name ?? "Anonymous";
    label.style.backgroundColor = color;
  }
}

/**
 * Default renderer: an SVG pointer arrow with a colored name label. Returns a
 * single element so consumers can apply their own transforms to it (the overlay
 * transforms the wrapper, not this node).
 */
export function defaultRenderCursor(cursor: RemoteCursor): HTMLElement {
  const el = document.createElement("div");
  el.className = "tp-cursor-pointer";
  el.innerHTML = `${CURSOR_ARROW_SVG}<span class="tp-cursor-label"></span>`;
  applyCursorInfo(el, cursor);
  return el;
}

/** Default update: refresh the built-in label text and color. */
export function defaultUpdateCursor(el: HTMLElement, cursor: RemoteCursor): void {
  applyCursorInfo(el, cursor);
}

/** Default selector for a peer's cursor position: `state.user.cursor`. */
export function defaultGetCursor(state: any): CursorPosition | null | undefined {
  return state?.user?.cursor;
}

/** Default selector for a peer's display name: `state.user.name`. */
export function defaultGetName(state: any): string | undefined {
  return state?.user?.name;
}

/** Default selector for a peer's cursor color: `state.user.color`. */
export function defaultGetColor(state: any): string | undefined {
  return state?.user?.color;
}
