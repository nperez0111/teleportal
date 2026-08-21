/**
 * A leading + trailing throttle. Publishing cursor positions on every
 * `pointermove` would flood the backend (pointer events fire far faster than any
 * sync server wants to fan out); this caps the rate while never losing the most
 * recent value.
 *
 * Behavior:
 * - The **first** call invokes `fn` immediately (leading edge), so there is no
 *   input latency at the start of a gesture.
 * - Subsequent calls within `intervalMs` are coalesced; when the window closes,
 *   `fn` is invoked once more with the **latest** value (trailing edge), so the
 *   final resting position is always delivered.
 * - `intervalMs <= 0` disables throttling — every call invokes `fn` synchronously.
 *
 * Kept dependency-free and DOM-free so it is unit-testable in isolation.
 */
export interface Throttled<T> {
  /** Enqueue a value: invokes now (leading) or schedules a trailing call. */
  (value: T): void;
  /** Cancel any pending trailing invocation without running it. */
  cancel(): void;
}

export function throttle<T>(fn: (value: T) => void, intervalMs: number): Throttled<T> {
  let lastRun = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let latest: T;

  const run = () => {
    timer = null;
    lastRun = Date.now();
    fn(latest);
  };

  const throttled = ((value: T) => {
    latest = value;
    const elapsed = Date.now() - lastRun;
    if (elapsed >= intervalMs) {
      // Enough time has passed — run immediately, dropping any pending trailing call.
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      run();
    } else if (timer === null) {
      // Inside the window — schedule a single trailing call for when it closes.
      timer = setTimeout(run, intervalMs - elapsed);
    }
  }) as Throttled<T>;

  throttled.cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return throttled;
}
