import type { Update } from "teleportal";

/**
 * Calculates the size of a document update in bytes.
 *
 * @param update - The Y.js update as a Uint8Array
 * @returns The size of the update in bytes
 */
export function calculateDocumentSize(update: Update | null | undefined): number {
  if (!update) {
    return 0;
  }
  return update.length;
}

/**
 * Byte-wise equality check.
 */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
