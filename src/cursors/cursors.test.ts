import { describe, expect, it } from "bun:test";

import { defaultGetColor, defaultGetCursor, defaultGetName } from "./render";
import { isSpringAtRest, stepSpring, type SpringParams, type SpringState } from "./spring";
import { throttle } from "./throttle";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const SPRING: SpringParams = { stiffness: 180, damping: 24 };
const DT = 1 / 60;

/** Run the spring toward `target` until it rests or we hit `maxFrames`. */
function settle(
  start: SpringState,
  target: number,
  maxFrames = 1000,
): { state: SpringState; frames: number; maxPosition: number } {
  let state = start;
  let maxPosition = start.position;
  for (let frame = 1; frame <= maxFrames; frame++) {
    state = stepSpring(state, target, DT, SPRING);
    maxPosition = Math.max(maxPosition, state.position);
    if (isSpringAtRest(state, target, 0.5, 0.5)) {
      return { state, frames: frame, maxPosition };
    }
  }
  return { state, frames: maxFrames, maxPosition };
}

describe("stepSpring", () => {
  it("moves toward the target on the first step", () => {
    const next = stepSpring({ position: 0, velocity: 0 }, 100, DT, SPRING);
    expect(next.position).toBeGreaterThan(0);
    expect(next.position).toBeLessThan(100);
    expect(next.velocity).toBeGreaterThan(0);
  });

  it("converges to the target and comes to rest", () => {
    const { state, frames } = settle({ position: 0, velocity: 0 }, 100);
    expect(frames).toBeLessThan(1000); // reached rest, did not time out
    expect(state.position).toBeCloseTo(100, 0);
    expect(Math.abs(state.velocity)).toBeLessThan(0.5);
  });

  it("does not overshoot meaningfully with the default damping", () => {
    const { maxPosition } = settle({ position: 0, velocity: 0 }, 100);
    // A well-damped spring should barely, if at all, cross the target.
    expect(maxPosition).toBeLessThan(101);
  });

  it("stays finite and bounded across a large dt (post tab-switch)", () => {
    // Even an un-clamped huge dt must not explode into NaN/Infinity.
    const next = stepSpring({ position: 0, velocity: 0 }, 100, 5, SPRING);
    expect(Number.isFinite(next.position)).toBe(true);
    expect(Number.isFinite(next.velocity)).toBe(true);
  });

  it("is symmetric for negative targets", () => {
    const { state } = settle({ position: 0, velocity: 0 }, -100);
    expect(state.position).toBeCloseTo(-100, 0);
  });
});

describe("isSpringAtRest", () => {
  it("is false while far from the target", () => {
    expect(isSpringAtRest({ position: 0, velocity: 0 }, 100, 0.5, 0.5)).toBe(false);
  });

  it("is false when near the target but still moving fast", () => {
    expect(isSpringAtRest({ position: 100, velocity: 50 }, 100, 0.5, 0.5)).toBe(false);
  });

  it("is true when both distance and speed are below threshold", () => {
    expect(isSpringAtRest({ position: 99.9, velocity: 0.1 }, 100, 0.5, 0.5)).toBe(true);
  });
});

describe("default awareness selectors", () => {
  const state = { user: { name: "Ada", color: "#f00", cursor: { x: 3, y: 4 } } };

  it("reads cursor, name, and color from state.user", () => {
    expect(defaultGetCursor(state)).toEqual({ x: 3, y: 4 });
    expect(defaultGetName(state)).toBe("Ada");
    expect(defaultGetColor(state)).toBe("#f00");
  });

  it("is null-safe for empty or partial state", () => {
    expect(defaultGetCursor(undefined)).toBeUndefined();
    expect(defaultGetCursor({})).toBeUndefined();
    expect(defaultGetName({ user: {} })).toBeUndefined();
    expect(defaultGetCursor({ user: { cursor: null } })).toBeNull();
  });
});

describe("throttle (publish rate limiting)", () => {
  it("invokes immediately on the leading edge", () => {
    const calls: string[] = [];
    const push = throttle((v: string) => calls.push(v), 5);
    push("a");
    expect(calls).toEqual(["a"]);
  });

  it("coalesces a burst to leading + latest-value trailing call", async () => {
    const calls: number[] = [];
    const push = throttle((v: number) => calls.push(v), 5);
    push(1); // leading — fires now
    push(2);
    push(3); // superseded before the window closes
    expect(calls).toEqual([1]);
    await sleep(12);
    // The trailing call delivers the most recent value, not the intermediate one.
    expect(calls).toEqual([1, 3]);
  });

  it("caps the number of publishes across a fast burst", async () => {
    const calls: number[] = [];
    const push = throttle((v: number) => calls.push(v), 5);
    for (let i = 0; i < 20; i++) {
      push(i);
      await sleep(1);
    }
    await sleep(12);
    // 20 rapid calls over ~20ms must not become 20 publishes at a 5ms interval.
    expect(calls.length).toBeLessThan(12);
    expect(calls[0]).toBe(0); // leading edge
    expect(calls.at(-1)).toBe(19); // final resting value always delivered
  });

  it("cancel() drops a pending trailing call", async () => {
    const calls: string[] = [];
    const push = throttle((v: string) => calls.push(v), 5);
    push("a"); // leading
    push("b"); // schedules trailing
    push.cancel();
    await sleep(12);
    expect(calls).toEqual(["a"]);
  });

  it("does not throttle when the interval is zero", () => {
    const calls: number[] = [];
    const push = throttle((v: number) => calls.push(v), 0);
    push(1);
    push(2);
    push(3);
    expect(calls).toEqual([1, 2, 3]);
  });
});
