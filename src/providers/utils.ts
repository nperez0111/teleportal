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
