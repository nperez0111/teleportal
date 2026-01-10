/**
 * Timer interface for dependency injection
 */
export interface Timer {
  setTimeout: (
    callback: () => void,
    delay: number,
  ) => ReturnType<typeof setTimeout>;
  setInterval: (
    callback: () => void,
    interval: number,
  ) => ReturnType<typeof setInterval>;
  clearTimeout: (id: ReturnType<typeof setTimeout>) => void;
  clearInterval: (id: ReturnType<typeof setInterval>) => void;
}

/**
 * Default timer implementation using global timers
 */
export const defaultTimer: Timer = {
  setTimeout: globalThis.setTimeout.bind(globalThis),
  setInterval: globalThis.setInterval.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  clearInterval: globalThis.clearInterval.bind(globalThis),
};

/**
 * Timer manager for tracking and cleaning up timers
 */
export class TimerManager {
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private intervals = new Set<ReturnType<typeof setInterval>>();
  private timer: Timer;

  constructor(timer: Timer = defaultTimer) {
    this.timer = timer;
  }

  /**
   * Get the underlying timer implementation (for passing to child connections)
   */
  get underlyingTimer(): Timer {
    return this.timer;
  }

  setTimeout(
    callback: () => void,
    delay: number,
  ): ReturnType<typeof setTimeout> {
    const id = this.timer.setTimeout(() => {
      this.timers.delete(id);
      callback();
    }, delay);
    this.timers.add(id);
    return id;
  }

  setInterval(
    callback: () => void,
    interval: number,
  ): ReturnType<typeof setInterval> {
    const id = this.timer.setInterval(callback, interval);
    this.intervals.add(id);
    return id;
  }

  clearTimeout(id: ReturnType<typeof setTimeout>): void {
    this.timer.clearTimeout(id);
    this.timers.delete(id);
  }

  clearInterval(id: ReturnType<typeof setInterval>): void {
    this.timer.clearInterval(id);
    this.intervals.delete(id);
  }

  clearAll(): void {
    for (const id of this.timers) {
      this.timer.clearTimeout(id);
    }
    for (const id of this.intervals) {
      this.timer.clearInterval(id);
    }
    this.timers.clear();
    this.intervals.clear();
  }
}

/**
 * Exponential backoff implementation inspired by websocket-ts
 */
export class ExponentialBackoff {
  private readonly base: number;
  private readonly maxExponent?: number;
  private i: number = 0;
  private _retries: number = 0;

  constructor(base: number, maxExponent?: number) {
    if (!Number.isInteger(base) || base < 0) {
      throw new Error("Base must be a positive integer or zero");
    }
    if (
      maxExponent !== undefined &&
      (!Number.isInteger(maxExponent) || maxExponent < 0)
    ) {
      throw new Error(
        "MaxExponent must be undefined, a positive integer or zero",
      );
    }

    this.base = base;
    this.maxExponent = maxExponent;
  }

  get retries(): number {
    return this._retries;
  }

  get current(): number {
    return this.base * Math.pow(2, this.i);
  }

  next(): number {
    this._retries++;
    this.i =
      this.maxExponent === undefined
        ? this.i + 1
        : Math.min(this.i + 1, this.maxExponent);
    return this.current;
  }

  reset(): void {
    this._retries = 0;
    this.i = 0;
  }
}
