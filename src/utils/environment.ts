export const isNode =
  typeof process !== "undefined" &&
  typeof process.versions !== "undefined" &&
  typeof process.versions.node !== "undefined";

export const isBrowser =
  typeof globalThis.navigator !== "undefined" && !isNode;
