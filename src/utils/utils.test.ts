import { describe, expect, it } from "bun:test";
import {
  toBase64,
  fromBase64,
  toBase64UrlEncoded,
  fromBase64UrlEncoded,
  toHexString,
} from "./buffer";
import { isBrowser, isNode } from "./environment";

describe("environment", () => {
  it("detects non-browser environment in Bun", () => {
    expect(isBrowser).toBe(false);
  });

  it("detects node-compatible environment in Bun", () => {
    expect(isNode).toBe(true);
  });
});

describe("toBase64 / fromBase64", () => {
  it("round-trips empty array", () => {
    const bytes = new Uint8Array(0);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });

  it("round-trips single byte", () => {
    const bytes = new Uint8Array([42]);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });

  it("round-trips all byte values", () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });

  it("produces standard base64 encoding", () => {
    const bytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    expect(toBase64(bytes)).toBe("SGVsbG8=");
  });

  it("decodes standard base64", () => {
    const decoded = fromBase64("SGVsbG8=");
    expect(Array.from(decoded)).toEqual([72, 101, 108, 108, 111]);
  });

  it("handles inputs that produce +, /, and = in base64", () => {
    // 0xFB, 0xEF, 0xBE produces base64 with + and /
    const bytes = new Uint8Array([0xfb, 0xef, 0xbe]);
    const b64 = toBase64(bytes);
    expect(fromBase64(b64)).toEqual(bytes);
  });
});

describe("toBase64UrlEncoded / fromBase64UrlEncoded", () => {
  it("round-trips empty array", () => {
    const bytes = new Uint8Array(0);
    expect(fromBase64UrlEncoded(toBase64UrlEncoded(bytes))).toEqual(bytes);
  });

  it("round-trips various lengths (padding edge cases)", () => {
    for (let len = 0; len <= 8; len++) {
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = i + 100;
      const encoded = toBase64UrlEncoded(bytes);
      const decoded = fromBase64UrlEncoded(encoded);
      expect(decoded).toEqual(bytes);
    }
  });

  it("replaces + with - and / with _", () => {
    // 0xFB, 0xEF, 0xBE in standard base64 is "u+++"
    const bytes = new Uint8Array([0xfb, 0xef, 0xbe]);
    const urlEncoded = toBase64UrlEncoded(bytes);
    expect(urlEncoded).not.toContain("+");
    expect(urlEncoded).not.toContain("/");
    expect(urlEncoded).not.toContain("=");
  });

  it("strips padding characters", () => {
    const bytes = new Uint8Array([1]); // produces "AQ==" in base64
    const urlEncoded = toBase64UrlEncoded(bytes);
    expect(urlEncoded).not.toContain("=");
    expect(fromBase64UrlEncoded(urlEncoded)).toEqual(bytes);
  });

  it("round-trips 32-byte hash (SHA-256 size)", () => {
    const hash = new Uint8Array(32);
    for (let i = 0; i < 32; i++) hash[i] = i * 8;
    expect(fromBase64UrlEncoded(toBase64UrlEncoded(hash))).toEqual(hash);
  });
});

describe("toHexString", () => {
  it("returns empty string for empty array", () => {
    expect(toHexString(new Uint8Array(0))).toBe("");
  });

  it("converts single byte to two hex chars", () => {
    expect(toHexString(new Uint8Array([0]))).toBe("00");
    expect(toHexString(new Uint8Array([255]))).toBe("ff");
    expect(toHexString(new Uint8Array([16]))).toBe("10");
  });

  it("pads single-digit hex values with zero", () => {
    expect(toHexString(new Uint8Array([1]))).toBe("01");
    expect(toHexString(new Uint8Array([15]))).toBe("0f");
  });

  it("converts multiple bytes", () => {
    expect(toHexString(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))).toBe("deadbeef");
  });

  it("handles all byte values correctly", () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    const hex = toHexString(bytes);
    expect(hex.length).toBe(512);
    expect(hex.startsWith("000102")).toBe(true);
    expect(hex.endsWith("fdfeff")).toBe(true);
  });
});
