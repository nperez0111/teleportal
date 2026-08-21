/**
 * A tiny, dependency-free spring integrator used to smooth remote cursor
 * movement. Instead of snapping a cursor to each incoming position (which looks
 * choppy at typical awareness update rates), we treat the rendered position as a
 * mass on a spring pulled toward the latest target. This produces the natural
 * "trailing" motion popularized by multiplayer cursor demos.
 *
 * The math here is intentionally pure so it can be unit-tested without a DOM.
 */

/** Position + velocity of a single 1D spring. */
export interface SpringState {
  position: number;
  velocity: number;
}

/** Resolved spring tuning used by {@link stepSpring}. */
export interface SpringParams {
  /** Higher = snappier pull toward the target. */
  stiffness: number;
  /** Higher = less oscillation / overshoot. */
  damping: number;
}

/**
 * Advance a spring by `dt` seconds toward `target`.
 *
 * Uses semi-implicit Euler integration with an exponential velocity decay so it
 * stays stable across a wide range of frame times (the caller should still clamp
 * `dt` — see {@link CursorSmootherOptions.maxTimeStep}).
 */
export function stepSpring(
  state: SpringState,
  target: number,
  dt: number,
  params: SpringParams,
): SpringState {
  const decay = Math.exp(-params.damping * dt);
  let velocity = state.velocity + (target - state.position) * params.stiffness * dt;
  velocity *= decay;
  const position = state.position + velocity * dt;
  return { position, velocity };
}

/**
 * True when a spring has effectively reached its target: both the remaining
 * distance and the speed are below the given thresholds. Callers snap to the
 * target and stop animating once this returns `true`.
 */
export function isSpringAtRest(
  state: SpringState,
  target: number,
  restDelta: number,
  restSpeed: number,
): boolean {
  return Math.abs(target - state.position) < restDelta && Math.abs(state.velocity) < restSpeed;
}
