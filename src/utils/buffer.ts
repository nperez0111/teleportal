import { isBrowser } from "./environment";

const toBase64Browser = (bytes: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    s += String.fromCharCode(bytes[i]);
  }
  return btoa(s);
};

const toBase64Node = (bytes: Uint8Array): string =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");

const fromBase64Browser = (s: string): Uint8Array => {
  const a = atob(s);
  const bytes = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) {
    bytes[i] = a.charCodeAt(i);
  }
  return bytes;
};

const fromBase64Node = (s: string): Uint8Array => {
  const buf = Buffer.from(s, "base64");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
};

export const toBase64: (bytes: Uint8Array) => string = isBrowser ? toBase64Browser : toBase64Node;

export const fromBase64: (s: string) => Uint8Array = isBrowser ? fromBase64Browser : fromBase64Node;

export const toBase64UrlEncoded = (buf: Uint8Array): string =>
  toBase64(buf).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

export const fromBase64UrlEncoded = (base64: string): Uint8Array => {
  const standard = base64.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard.length % 4 === 0 ? standard : standard + "=".repeat(4 - (standard.length % 4));
  return fromBase64(padded);
};

export const toHexString = (buf: Uint8Array): string =>
  Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
