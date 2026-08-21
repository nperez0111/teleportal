import type { Awareness } from "y-protocols/awareness";

import {
  defaultGetColor,
  defaultGetCursor,
  defaultGetName,
  defaultRenderCursor,
  defaultUpdateCursor,
} from "./render";
import { isSpringAtRest, stepSpring, type SpringParams } from "./spring";
import { injectCursorStyles } from "./styles";
import type { CursorOverlayOptions, RemoteCursor } from "./types";

const DEFAULT_SPRING = {
  stiffness: 180,
  damping: 24,
  restDelta: 0.5,
  restSpeed: 0.5,
  maxTimeStep: 0.064,
} as const;

const DEFAULT_STALE_TIMEOUT = 5000;
const DEFAULT_TIP_OFFSET = 2;
/** How often to sweep for cursors that have gone stale. */
const PRUNE_INTERVAL = 2000;

interface CursorEntry {
  /** Positioned wrapper the overlay owns and transforms. */
  wrapper: HTMLElement;
  /** Consumer-rendered content node (the return of `renderCursor`). */
  content: HTMLElement;
  lastSeen: number;
  targetX: number;
  targetY: number;
  currentX: number;
  currentY: number;
  velocityX: number;
  velocityY: number;
  /** True while the spring is still settling toward the target. */
  active: boolean;
  cursor: RemoteCursor;
}

/**
 * Renders every remote peer's cursor from a Y.js {@link Awareness} instance and
 * smoothly animates each one toward its latest position with a spring. A single
 * shared `requestAnimationFrame` loop drives all cursors and stops itself once
 * everything has settled.
 *
 * Pair with {@link trackPointer} to also publish the local pointer.
 */
export class CursorOverlay {
  #awareness: Awareness;
  #container: HTMLElement;
  /** True when the overlay created (and therefore owns) `#container`. */
  #ownsContainer: boolean;
  #cursors = new Map<number, CursorEntry>();

  #getCursor: NonNullable<CursorOverlayOptions["getCursor"]>;
  #getName: NonNullable<CursorOverlayOptions["getName"]>;
  #getColor: NonNullable<CursorOverlayOptions["getColor"]>;
  #renderCursor: NonNullable<CursorOverlayOptions["renderCursor"]>;
  #updateCursor: NonNullable<CursorOverlayOptions["updateCursor"]>;
  #onCursorClick: CursorOverlayOptions["onCursorClick"];
  #onCursorAdd: CursorOverlayOptions["onCursorAdd"];
  #onCursorRemove: CursorOverlayOptions["onCursorRemove"];

  #spring: SpringParams;
  #restDelta: number;
  #restSpeed: number;
  #maxTimeStep: number;
  #staleTimeout: number;
  #tipOffset: number;

  #rafId = 0;
  #animating = false;
  #lastFrameTime = 0;
  #pruneTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: CursorOverlayOptions) {
    if (typeof document === "undefined") {
      throw new Error("CursorOverlay requires a DOM (it must run in the browser).");
    }

    this.#awareness = options.awareness;
    this.#getCursor = options.getCursor ?? defaultGetCursor;
    this.#getName = options.getName ?? defaultGetName;
    this.#getColor = options.getColor ?? defaultGetColor;
    this.#renderCursor = options.renderCursor ?? defaultRenderCursor;
    this.#updateCursor = options.updateCursor ?? defaultUpdateCursor;
    this.#onCursorClick = options.onCursorClick;
    this.#onCursorAdd = options.onCursorAdd;
    this.#onCursorRemove = options.onCursorRemove;

    this.#spring = {
      stiffness: options.spring?.stiffness ?? DEFAULT_SPRING.stiffness,
      damping: options.spring?.damping ?? DEFAULT_SPRING.damping,
    };
    this.#restDelta = options.spring?.restDelta ?? DEFAULT_SPRING.restDelta;
    this.#restSpeed = options.spring?.restSpeed ?? DEFAULT_SPRING.restSpeed;
    this.#maxTimeStep = options.spring?.maxTimeStep ?? DEFAULT_SPRING.maxTimeStep;
    this.#staleTimeout = options.staleTimeout ?? DEFAULT_STALE_TIMEOUT;
    this.#tipOffset = options.tipOffset ?? DEFAULT_TIP_OFFSET;

    if (options.injectStyles !== false) {
      injectCursorStyles();
    }

    if (options.container) {
      this.#container = options.container;
      this.#ownsContainer = false;
    } else {
      this.#container = document.createElement("div");
      this.#container.className = "tp-cursors";
      document.body.appendChild(this.#container);
      this.#ownsContainer = true;
    }
    if (this.#onCursorClick) {
      this.#container.classList.add("tp-cursors--interactive");
    }

    this.#awareness.on("change", this.#onAwarenessChange);
    this.#pruneTimer = setInterval(
      () => this.#pruneStale(),
      Math.min(PRUNE_INTERVAL, this.#staleTimeout),
    );
    // Render peers already present before we attached the listener.
    this.#onAwarenessChange();
  }

  #onAwarenessChange = (): void => {
    const states = this.#awareness.getStates();
    const localId = this.#awareness.clientID;
    const now = Date.now();
    const activePeers = new Set<number>();

    states.forEach((state: Record<string, unknown>, id: number) => {
      if (id === localId) return;
      const position = this.#getCursor(state);
      if (!position) return;

      activePeers.add(id);
      const cursor: RemoteCursor = {
        clientId: id,
        position: { x: position.x, y: position.y },
        name: this.#getName(state),
        color: this.#getColor(state),
        state,
      };

      let entry = this.#cursors.get(id);
      if (!entry) {
        entry = this.#createEntry(cursor);
        this.#cursors.set(id, entry);
      } else {
        entry.cursor = cursor;
        this.#updateCursor(entry.content, cursor);
      }

      entry.lastSeen = now;
      entry.targetX = position.x;
      entry.targetY = position.y;
      entry.active = true;
      entry.wrapper.classList.remove("tp-cursor--stale");
    });

    // Peers with no active cursor (left the surface) fade out but are not removed
    // until they go fully stale — this survives brief awareness churn.
    for (const [id, entry] of this.#cursors) {
      if (!activePeers.has(id)) {
        entry.wrapper.classList.add("tp-cursor--stale");
      }
    }

    this.#startAnimation();
  };

  #createEntry(cursor: RemoteCursor): CursorEntry {
    const wrapper = document.createElement("div");
    wrapper.className = "tp-cursor";
    wrapper.dataset.clientId = String(cursor.clientId);

    const content = this.#renderCursor(cursor);
    wrapper.appendChild(content);

    // Place immediately at the first known position (no spring wind-up).
    wrapper.style.transform = this.#transformFor(cursor.position.x, cursor.position.y);

    this.#container.appendChild(wrapper);

    const entry: CursorEntry = {
      wrapper,
      content,
      lastSeen: Date.now(),
      targetX: cursor.position.x,
      targetY: cursor.position.y,
      currentX: cursor.position.x,
      currentY: cursor.position.y,
      velocityX: 0,
      velocityY: 0,
      active: false,
      cursor,
    };

    if (this.#onCursorClick) {
      // Read `entry.cursor` lazily so clicks see the peer's latest name/color/state.
      wrapper.addEventListener("click", () => this.#onCursorClick!(entry.cursor, content));
    }

    this.#onCursorAdd?.(cursor, content);
    return entry;
  }

  #transformFor(x: number, y: number): string {
    return `translate(${x - this.#tipOffset}px, ${y - this.#tipOffset}px)`;
  }

  #startAnimation(): void {
    if (this.#animating) return;
    this.#animating = true;
    this.#lastFrameTime = performance.now();
    this.#rafId = requestAnimationFrame(this.#tick);
  }

  #tick = (now: number): void => {
    const dt = Math.min((now - this.#lastFrameTime) / 1000, this.#maxTimeStep);
    this.#lastFrameTime = now;

    let anyActive = false;

    for (const entry of this.#cursors.values()) {
      if (!entry.active) continue;

      const nextX = stepSpring(
        { position: entry.currentX, velocity: entry.velocityX },
        entry.targetX,
        dt,
        this.#spring,
      );
      const nextY = stepSpring(
        { position: entry.currentY, velocity: entry.velocityY },
        entry.targetY,
        dt,
        this.#spring,
      );
      entry.currentX = nextX.position;
      entry.velocityX = nextX.velocity;
      entry.currentY = nextY.position;
      entry.velocityY = nextY.velocity;

      const settled =
        isSpringAtRest(nextX, entry.targetX, this.#restDelta, this.#restSpeed) &&
        isSpringAtRest(nextY, entry.targetY, this.#restDelta, this.#restSpeed);

      if (settled) {
        entry.currentX = entry.targetX;
        entry.currentY = entry.targetY;
        entry.velocityX = 0;
        entry.velocityY = 0;
        entry.active = false;
      } else {
        anyActive = true;
      }

      entry.wrapper.style.transform = this.#transformFor(entry.currentX, entry.currentY);
    }

    if (anyActive) {
      this.#rafId = requestAnimationFrame(this.#tick);
    } else {
      this.#animating = false;
    }
  };

  #pruneStale(): void {
    const now = Date.now();
    for (const [id, entry] of this.#cursors) {
      if (now - entry.lastSeen > this.#staleTimeout) {
        this.#removeEntry(id, entry);
      }
    }
  }

  #removeEntry(id: number, entry: CursorEntry): void {
    entry.wrapper.remove();
    this.#cursors.delete(id);
    this.#onCursorRemove?.(id);
  }

  /** Detach listeners, cancel animation, and remove all cursor DOM. */
  destroy(): void {
    this.#awareness.off("change", this.#onAwarenessChange);
    if (this.#pruneTimer !== undefined) clearInterval(this.#pruneTimer);
    if (this.#rafId) cancelAnimationFrame(this.#rafId);
    this.#animating = false;
    for (const [id, entry] of this.#cursors) {
      this.#removeEntry(id, entry);
    }
    if (this.#ownsContainer) {
      this.#container.remove();
    } else {
      this.#container.classList.remove("tp-cursors--interactive");
    }
  }
}
