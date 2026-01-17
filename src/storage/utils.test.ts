import { describe, expect, it } from "bun:test";
import { calculateDocumentSize } from "./utils";
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
