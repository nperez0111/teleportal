import type { Awareness } from "y-protocols/awareness";
import { CursorOverlay as BaseCursorOverlay, trackPointer } from "teleportal/cursors";

/**
 * Docs-specific cursor overlay. The spring smoothing, rendering, and awareness
 * plumbing now live in `teleportal/cursors`; this wrapper adds the two demo-only
 * affordances on top: click-to-boop and hover-dwell-to-highlight.
 */
export class CursorOverlay {
  #base: BaseCursorOverlay;
  #stopTracking: () => void;
  #onBoopTarget: ((awarenessId: number) => void) | null = null;

  /** clientId -> the rendered cursor content element (from `onCursorAdd`). */
  #elements = new Map<number, HTMLElement>();

  #dwellTarget: number | null = null;
  #dwellTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(awareness: Awareness) {
    // Send page-relative coordinates so cursors track the document, not the viewport.
    this.#stopTracking = trackPointer({
      awareness,
      getPosition: (e) => ({ x: e.pageX, y: e.pageY }),
    });

    // Create a page-relative container (absolute, not fixed) so cursors scroll with content.
    const container = document.createElement("div");
    container.style.cssText =
      "position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:99999;overflow:visible;";
    document.body.appendChild(container);

    this.#base = new BaseCursorOverlay({
      awareness,
      container,
      injectStyles: true,
      onCursorClick: (cursor) => this.#onBoopTarget?.(cursor.clientId),
      onCursorAdd: (cursor, el) => this.#elements.set(cursor.clientId, el),
      onCursorRemove: (id) => {
        this.#elements.delete(id);
        if (this.#dwellTarget === id) this.#clearDwell();
      },
    });

    document.addEventListener("pointermove", this.#onPointerMove);
  }

  set onBoopTarget(fn: ((awarenessId: number) => void) | null) {
    this.#onBoopTarget = fn;
  }

  // ---------------------------------------------------------------------------
  // Hover-dwell-to-boop interaction (docs only)
  // ---------------------------------------------------------------------------

  #onPointerMove = (e: PointerEvent) => {
    this.#checkDwell(e.clientX, e.clientY);
  };

  #checkDwell(mx: number, my: number) {
    const PROXIMITY = 40;
    let closest: { id: number; dist: number } | null = null;

    for (const [id, el] of this.#elements) {
      const rect = el.getBoundingClientRect();
      const cx = rect.left + 10;
      const cy = rect.top + 10;
      const dist = Math.hypot(mx - cx, my - cy);
      if (dist < PROXIMITY && (!closest || dist < closest.dist)) {
        closest = { id, dist };
      }
    }

    if (closest && closest.id === this.#dwellTarget) return;

    this.#clearDwell();

    if (closest) {
      this.#dwellTarget = closest.id;
      this.#dwellTimer = setTimeout(() => {
        this.#elements.get(this.#dwellTarget!)?.classList.add("tp-cursor-boopable");
      }, 1000);
    }
  }

  #clearDwell() {
    if (this.#dwellTimer) clearTimeout(this.#dwellTimer);
    this.#dwellTimer = null;
    if (this.#dwellTarget !== null) {
      this.#elements.get(this.#dwellTarget)?.classList.remove("tp-cursor-boopable");
    }
    this.#dwellTarget = null;
  }

  destroy() {
    document.removeEventListener("pointermove", this.#onPointerMove);
    this.#clearDwell();
    this.#stopTracking();
    this.#base.destroy();
  }
}
