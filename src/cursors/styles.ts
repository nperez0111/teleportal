/**
 * The minimal stylesheet the overlay needs to position and reveal cursors.
 * Everything is themeable via the `--tp-cursor-color` custom property and plain
 * class overrides — consumers can ship their own CSS and pass
 * `injectStyles: false` instead.
 */
export const CURSOR_STYLES = `
.tp-cursors {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 99999;
  overflow: hidden;
}

.tp-cursor {
  position: absolute;
  left: 0;
  top: 0;
  pointer-events: none;
  will-change: transform;
  transition: opacity 300ms ease;
}

.tp-cursors--interactive .tp-cursor {
  pointer-events: auto;
  cursor: pointer;
}

.tp-cursor--stale {
  opacity: 0;
}

.tp-cursor-pointer {
  position: relative;
}

.tp-cursor-label {
  position: absolute;
  left: 18px;
  top: 0;
  font: 600 11px/1.4 system-ui, -apple-system, sans-serif;
  padding: 1px 6px;
  border-radius: 4px;
  white-space: nowrap;
  color: #000;
  pointer-events: none;
}
`;

const STYLE_ELEMENT_ID = "tp-cursor-styles";

/**
 * Inject {@link CURSOR_STYLES} into `document.head` exactly once (keyed by a
 * stable id). No-op outside the browser or if already injected.
 */
export function injectCursorStyles(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ELEMENT_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent = CURSOR_STYLES;
  document.head.appendChild(style);
}
