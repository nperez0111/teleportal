import { describe, expect, it } from "bun:test";
import { bytesEqual, calculateDocumentSize } from "./utils";
import type { Update } from "teleportal";

describe("calculateDocumentSize", () => {
  it("should return 0 for null", () => {
    expect(calculateDocumentSize(null)).toBe(0);
  });

  it("should return 0 for undefined", () => {
    expect(calculateDocumentSize(undefined)).toBe(0);
  });

  it("should return correct size for empty Uint8Array", () => {
    const update = new Uint8Array(0) as Update;
    expect(calculateDocumentSize(update)).toBe(0);
  });

  it("should return correct size for non-empty Uint8Array", () => {
    const update = new Uint8Array([1, 2, 3, 4, 5]) as Update;
    expect(calculateDocumentSize(update)).toBe(5);
  });
});

describe("bytesEqual", () => {
  it("returns true for two empty arrays", () => {
    expect(bytesEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
  });

  it("returns true for identical contents in distinct arrays", () => {
    expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
  });

  it("returns false when lengths differ", () => {
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });

  it("returns false when a single byte differs", () => {
    expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 9, 3]))).toBe(false);
  });

  it("distinguishes a differing final byte (full scan, not early-exit only)", () => {
    // Guards against an implementation that stops before the last index.
    expect(bytesEqual(new Uint8Array([0, 0, 0, 1]), new Uint8Array([0, 0, 0, 2]))).toBe(false);
  });
});
