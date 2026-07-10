# `teleportal/cursors` — spring-smoothed multiplayer cursors

Renders remote peers' cursors from a Y.js [`Awareness`](https://github.com/yjs/y-protocols)
instance and animates each one toward its latest position with a spring, so
cursors glide instead of teleporting between the (relatively infrequent)
awareness updates. Dependency-free and rendering-agnostic.

## Why it exists

Broadcasting a cursor position on every `pointermove` would flood the network, so
apps throttle updates to a handful per second. Drawing those raw positions looks
janky. This package decouples the two rates: you publish at whatever cadence you
like, and the overlay interpolates smoothly on every animation frame using a
critically-ish damped spring (the technique behind
[Liveblocks' animated cursors](https://liveblocks.io/blog/how-to-animate-multiplayer-cursors)).

Two pieces, usable independently:

- **`trackPointer(options)`** — publishes the local pointer into awareness (throttled so it never floods the backend).
- **`CursorOverlay`** — renders + smoothly animates every _other_ peer's cursor.

## Quick start

Works with the common `state.user = { name, color, cursor }` convention out of the box:

```typescript
import { CursorOverlay, trackPointer } from "teleportal/cursors";

// `awareness` from any teleportal provider, e.g. `provider.awareness`.
awareness.setLocalStateField("user", { name: "Ada", color: "#ff0055", cursor: null });

const stopTracking = trackPointer({ awareness });
const overlay = new CursorOverlay({ awareness });

// on teardown:
stopTracking();
overlay.destroy();
```

That's it — remote cursors appear as colored arrows with name labels and follow
their peers smoothly.

## How it works

- **Spring smoothing.** A single shared `requestAnimationFrame` loop drives every
  cursor. Each frame steps a per-axis spring toward the target position and
  writes a GPU-composited `transform: translate(...)`. The loop stops itself once
  all cursors have settled and restarts on the next awareness change, so idle
  tabs cost nothing. Frame deltas are clamped (`spring.maxTimeStep`) so a
  tab-switch or GC pause can't fling cursors across the screen. The integrator
  ([`spring.ts`](./spring.ts)) is pure and unit-tested.
- **Positioning is decoupled from content.** The overlay owns an outer wrapper
  element (which it transforms) and mounts your rendered content _inside_ it. You
  can freely apply your own transforms (a hover scale, a bounce) to the content
  without fighting the smoothing loop.
- **Staleness.** When a peer clears its cursor (leaves the surface) it fades out;
  if it goes `staleTimeout` ms without any update it is removed. Brief awareness
  churn therefore doesn't drop cursors.

## Customization

Every data-shape and rendering decision is a hook. To read cursors from a
different awareness shape, override the selectors:

```typescript
new CursorOverlay({
  awareness,
  getCursor: (state) => state.presence?.pointer, // e.g. { x, y }
  getName: (state) => state.presence?.displayName,
  getColor: (state) => state.presence?.tint,
});
```

To render your own cursor (the returned node is mounted inside the positioned
wrapper):

```typescript
new CursorOverlay({
  awareness,
  renderCursor: (cursor) => {
    const el = document.createElement("div");
    el.textContent = `👆 ${cursor.name ?? "?"}`;
    return el;
  },
  updateCursor: (el, cursor) => {
    el.textContent = `👆 ${cursor.name ?? "?"}`;
  },
});
```

Other useful options: `spring` (stiffness/damping/rest thresholds), `container`
(mount into your own element instead of a full-screen layer), `tipOffset`,
`staleTimeout`, and the `onCursorClick` / `onCursorAdd` / `onCursorRemove`
lifecycle hooks (handy for building interactions like click-to-react on top).

### Throttling publishes

Pointer events fire far faster than any sync server wants to fan out, so
`trackPointer` throttles awareness publishes to at most one per `throttleMs`
(default `50`, i.e. ~20 updates/second). The throttle is leading + trailing: the
first move of a gesture publishes immediately (no input lag) and the final
resting position is always delivered, while everything in between is coalesced.
The receiver's spring interpolation makes the motion look smooth regardless of
the publish rate, so you can raise `throttleMs` to cut traffic further:

```typescript
trackPointer({ awareness, throttleMs: 100 }); // ~10 updates/s
```

The underlying `throttle(fn, intervalMs)` primitive is exported if you want to
rate-limit your own awareness fields (typing indicators, selections, …).

### Bounded surfaces

By default `trackPointer` reports viewport coordinates. To track within a
specific element (e.g. a canvas) and report element-relative coordinates:

```typescript
trackPointer({
  awareness,
  target: canvas,
  getPosition: (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  },
});
```

### Styling

The overlay injects a minimal stylesheet once (disable with `injectStyles: false`
and import `CURSOR_STYLES` yourself). Cursor color is driven by the
`--tp-cursor-color` custom property. Relevant classes: `.tp-cursors` (layer),
`.tp-cursor` (positioned wrapper, carries `data-client-id`), `.tp-cursor--stale`,
`.tp-cursor-pointer`, `.tp-cursor-arrow`, `.tp-cursor-label`.

## API

- `class CursorOverlay(options: CursorOverlayOptions)` — `.destroy()` to tear down.
- `function trackPointer(options: TrackPointerOptions): () => void` — returns a cleanup function.
- `stepSpring` / `isSpringAtRest` — the pure spring primitives, if you want to build your own loop.
- `throttle(fn, intervalMs)` — the leading + trailing throttle used for publishing, exported for reuse.
- `defaultRenderCursor` / `defaultUpdateCursor` / `defaultGetCursor` / `defaultGetName` / `defaultGetColor` — the defaults, exported so you can wrap rather than replace them.
- `CURSOR_STYLES` / `injectCursorStyles` / `CURSOR_ARROW_SVG` — styling building blocks.

See [`types.ts`](./types.ts) for the full option reference.
