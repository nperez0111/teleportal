/**
 * Content-level encryption for Y.js updates.
 *
 * Transforms Y.js V1 updates to separate CRDT metadata (kept in plaintext
 * as a valid Y.js update) from document content (encrypted in a sidecar).
 *
 * The server can merge, sync, and store the structure update normally because
 * all CRDT metadata (client IDs, clocks, origins, parent refs, delete sets)
 * remains in plaintext. Only user-authored content (text, embeds, format
 * values, JSON, binary data) is encrypted.
 */

import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as Y from "yjs";
import { type EncryptedBinary, encryptUpdate, decryptUpdate } from "teleportal/encryption-key";
import { encodeContentEncryptedPayload } from "./encoding";

// ── Content type refs ───────────────────────────────────────────────────────

const CONTENT_DELETED = 1;
const CONTENT_JSON = 2;
const CONTENT_BINARY = 3;
const CONTENT_STRING = 4;
const CONTENT_EMBED = 5;
const CONTENT_FORMAT = 6;
const CONTENT_TYPE = 7;
const CONTENT_ANY = 8;
const CONTENT_DOC = 9;

// ── Info byte bit masks (lib0 binary constants) ─────────────────────────────

const BITS5 = 0x1f; // bits 0-4: contentRef
const BIT6 = 0x20; // bit 5: hasParentSub
const BIT7 = 0x40; // bit 6: hasRightOrigin
const BIT8 = 0x80; // bit 7: hasOrigin

// ── Metadata string hashing ────────────────────────────────────────────────

function opaqueToken(str: string): string {
  // 64-bit djb2. A 64-bit space makes collisions between distinct metadata
  // strings (root-type names, map keys, XML tag names) effectively impossible,
  // even for documents that accumulate many distinct keys over their lifetime.
  let hash = 5381n;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5n) + hash + BigInt(str.charCodeAt(i))) & 0xffffffffffffffffn;
  }
  return hash.toString(36);
}

// ── Sidecar types ───────────────────────────────────────────────────────────

type MetadataDictionary = Map<string, string>;

export type ContentEntry = {
  clientId: number;
  clock: number;
  contentRef: number;
  data: Uint8Array;
};

export type Sidecar = {
  entries: ContentEntry[];
  dictionary: MetadataDictionary;
};

export type StrippedUpdate = {
  update: Uint8Array;
  sidecar: Sidecar;
};

// ── Sidecar index (server-side filtering without decryption) ───────────────

export type SidecarClientRange = {
  clientId: number;
  minClock: number;
  maxClock: number;
};

export type SidecarIndex = SidecarClientRange[];

export type IndexedSidecar = {
  encrypted: EncryptedBinary;
  index: SidecarIndex;
};

export function buildSidecarIndex(entries: ContentEntry[]): SidecarIndex {
  const ranges = new Map<number, { min: number; max: number }>();
  for (const entry of entries) {
    const existing = ranges.get(entry.clientId);
    if (existing) {
      existing.min = Math.min(existing.min, entry.clock);
      existing.max = Math.max(existing.max, entry.clock);
    } else {
      ranges.set(entry.clientId, { min: entry.clock, max: entry.clock });
    }
  }
  return [...ranges.entries()].map(([clientId, { min, max }]) => ({
    clientId,
    minClock: min,
    maxClock: max,
  }));
}

export function buildSidecarIndexFromUpdateMeta(meta: {
  from: Map<number, number>;
  to: Map<number, number>;
}): SidecarIndex {
  return [...meta.from.entries()].map(([clientId, fromClock]) => ({
    clientId,
    minClock: fromClock,
    maxClock: (meta.to.get(clientId) ?? fromClock + 1) - 1,
  }));
}

export function sidecarOverlapsDiff(
  index: SidecarIndex,
  diffMeta: { from: Map<number, number>; to: Map<number, number> },
): boolean {
  for (const range of index) {
    const diffFrom = diffMeta.from.get(range.clientId);
    const diffTo = diffMeta.to.get(range.clientId);
    if (diffFrom === undefined || diffTo === undefined) continue;
    if (range.maxClock >= diffFrom && range.minClock < diffTo) {
      return true;
    }
  }
  return false;
}

// ── Sidecar binary encoding ─────────────────────────────────────────────────
//
// Column-based encoding, grouped by client:
//   [version=0]
//   [numDictEntries] per entry: [token(varString)] [original(varString)]
//   [numClients]
//   per client group:
//     [clientId] [numEntries]
//     [clocks as IntDiffOptRle bytes (varUint8Array)]
//     [contentRefs as UintOptRle bytes (varUint8Array)]
//     [data lengths as UintOptRle bytes (varUint8Array)]
//     [concatenated data (raw bytes, length = sum of data lengths)]
//

const SIDECAR_VERSION = 0;

type ClientGroup = { clientId: number; entries: ContentEntry[] };

function groupByClient(entries: ContentEntry[]): ClientGroup[] {
  const groups: ClientGroup[] = [];
  let current: ClientGroup | null = null;
  for (const entry of entries) {
    if (!current || current.clientId !== entry.clientId) {
      current = { clientId: entry.clientId, entries: [] };
      groups.push(current);
    }
    current.entries.push(entry);
  }
  return groups;
}

export function encodeSidecar(sidecar: Sidecar): Uint8Array {
  const groups = groupByClient(sidecar.entries);
  const dictionary = sidecar.dictionary;

  return encoding.encode((encoder) => {
    encoding.writeVarUint(encoder, SIDECAR_VERSION);

    encoding.writeVarUint(encoder, dictionary.size);
    for (const [token, original] of dictionary) {
      encoding.writeVarString(encoder, token);
      encoding.writeVarString(encoder, original);
    }

    encoding.writeVarUint(encoder, groups.length);

    for (const group of groups) {
      encoding.writeVarUint(encoder, group.clientId);
      encoding.writeVarUint(encoder, group.entries.length);

      // Clocks — delta-encoded with IntDiffOptRle
      const clockEnc = new encoding.IntDiffOptRleEncoder();
      for (const e of group.entries) clockEnc.write(e.clock);
      encoding.writeVarUint8Array(encoder, clockEnc.toUint8Array());

      // Content refs — RLE-encoded
      const refEnc = new encoding.UintOptRleEncoder();
      for (const e of group.entries) refEnc.write(e.contentRef);
      encoding.writeVarUint8Array(encoder, refEnc.toUint8Array());

      // Data lengths — RLE-encoded
      const lenEnc = new encoding.UintOptRleEncoder();
      let totalDataLen = 0;
      for (const e of group.entries) {
        lenEnc.write(e.data.length);
        totalDataLen += e.data.length;
      }
      encoding.writeVarUint8Array(encoder, lenEnc.toUint8Array());

      // Concatenated content data
      encoding.writeVarUint(encoder, totalDataLen);
      for (const e of group.entries) {
        encoding.writeUint8Array(encoder, e.data);
      }
    }
  });
}

export function decodeSidecar(data: Uint8Array): Sidecar {
  const decoder = decoding.createDecoder(data);
  const version = decoding.readVarUint(decoder);
  if (version !== SIDECAR_VERSION) {
    throw new Error(`Unsupported sidecar version: ${version}`);
  }

  const dictionary: MetadataDictionary = new Map();
  const numDictEntries = decoding.readVarUint(decoder);
  for (let i = 0; i < numDictEntries; i++) {
    const token = decoding.readVarString(decoder);
    const original = decoding.readVarString(decoder);
    dictionary.set(token, original);
  }

  const entries: ContentEntry[] = [];
  const numGroups = decoding.readVarUint(decoder);

  for (let g = 0; g < numGroups; g++) {
    const clientId = decoding.readVarUint(decoder);
    const numEntries = decoding.readVarUint(decoder);

    const clockDec = new decoding.IntDiffOptRleDecoder(decoding.readVarUint8Array(decoder));
    const refDec = new decoding.UintOptRleDecoder(decoding.readVarUint8Array(decoder));
    const lenDec = new decoding.UintOptRleDecoder(decoding.readVarUint8Array(decoder));

    const totalDataLen = decoding.readVarUint(decoder);
    const allData = decoding.readUint8Array(decoder, totalDataLen);

    let dataOffset = 0;
    for (let i = 0; i < numEntries; i++) {
      const clock = clockDec.read();
      const contentRef = refDec.read();
      const dataLen = lenDec.read();
      const data = allData.slice(dataOffset, dataOffset + dataLen);
      dataOffset += dataLen;

      entries.push({ clientId, clock, contentRef, data });
    }
  }

  return { entries, dictionary };
}

export function mergeSidecars(sidecars: Sidecar[]): Sidecar {
  const entries: ContentEntry[] = [];
  const dictionary: MetadataDictionary = new Map();
  for (const s of sidecars) {
    entries.push(...s.entries);
    for (const [token, original] of s.dictionary) {
      dictionary.set(token, original);
    }
  }
  return { entries, dictionary };
}

// ── Sidecar lookup ──────────────────────────────────────────────────────────

function sidecarKey(clientId: number, clock: number): string {
  return `${clientId}:${clock}`;
}

function buildSidecarMap(entries: ContentEntry[]): Map<string, ContentEntry> {
  const map = new Map<string, ContentEntry>();
  for (const entry of entries) {
    map.set(sidecarKey(entry.clientId, entry.clock), entry);
  }
  return map;
}

// ── V1 content readers (advance decoder, return raw bytes) ──────────────────

function readContentRawBytes(
  decoder: decoding.Decoder,
  contentRef: number,
): { data: Uint8Array; itemLength: number } {
  const startPos = decoder.pos;
  const itemLength = skipContent(decoder, contentRef);
  return {
    data: decoder.arr.slice(startPos, decoder.pos),
    itemLength,
  };
}

function skipContent(decoder: decoding.Decoder, contentRef: number): number {
  switch (contentRef) {
    case CONTENT_DELETED: {
      return decoding.readVarUint(decoder);
    }
    case CONTENT_JSON: {
      const count = decoding.readVarUint(decoder);
      for (let i = 0; i < count; i++) decoding.readVarString(decoder);
      return count;
    }
    case CONTENT_BINARY: {
      decoding.readVarUint8Array(decoder);
      return 1;
    }
    case CONTENT_STRING: {
      return decoding.readVarString(decoder).length;
    }
    case CONTENT_EMBED: {
      decoding.readVarString(decoder); // JSON-encoded string
      return 1;
    }
    case CONTENT_FORMAT: {
      decoding.readVarString(decoder); // key
      decoding.readVarString(decoder); // JSON-encoded value
      return 1;
    }
    case CONTENT_TYPE: {
      const typeRef = decoding.readVarUint(decoder);
      // YXmlElement (3) and YXmlHook (5) write an extra key string
      if (typeRef === 3 || typeRef === 5) {
        decoding.readVarString(decoder);
      }
      return 1;
    }
    case CONTENT_ANY: {
      const count = decoding.readVarUint(decoder);
      for (let i = 0; i < count; i++) decoding.readAny(decoder);
      return count;
    }
    case CONTENT_DOC: {
      decoding.readVarString(decoder); // guid
      decoding.readAny(decoder); // opts
      return 1;
    }
    default:
      throw new Error(`Unknown content ref: ${contentRef}`);
  }
}

// ── V1 placeholder content writers ──────────────────────────────────────────

function writePlaceholderContent(
  encoder: encoding.Encoder,
  contentRef: number,
  itemLength: number,
): void {
  switch (contentRef) {
    case CONTENT_DELETED: {
      encoding.writeVarUint(encoder, itemLength);
      break;
    }
    case CONTENT_JSON: {
      encoding.writeVarUint(encoder, itemLength);
      for (let i = 0; i < itemLength; i++) {
        encoding.writeVarString(encoder, "null");
      }
      break;
    }
    case CONTENT_BINARY: {
      encoding.writeVarUint8Array(encoder, new Uint8Array(0));
      break;
    }
    case CONTENT_STRING: {
      // Write a string of null characters with the same character length
      encoding.writeVarString(encoder, "\0".repeat(itemLength));
      break;
    }
    case CONTENT_EMBED: {
      encoding.writeVarString(encoder, "null");
      break;
    }
    case CONTENT_FORMAT: {
      // Keep a placeholder key and null value
      encoding.writeVarString(encoder, "\0");
      encoding.writeVarString(encoder, "null");
      break;
    }
    case CONTENT_TYPE: {
      // ContentType is structural — should never be called for it
      throw new Error("ContentType should be copied verbatim, not replaced");
    }
    case CONTENT_ANY: {
      encoding.writeVarUint(encoder, itemLength);
      for (let i = 0; i < itemLength; i++) {
        encoding.writeAny(encoder, null);
      }
      break;
    }
    case CONTENT_DOC: {
      encoding.writeVarString(encoder, "\0");
      encoding.writeAny(encoder, null);
      break;
    }
    default:
      throw new Error(`Unknown content ref: ${contentRef}`);
  }
}

// ── V1 CRDT metadata copier ─────────────────────────────────────────────────

function copyItemMetadata(
  decoder: decoding.Decoder,
  encoder: encoding.Encoder,
  info: number,
  transformString: (s: string) => string = (s) => s,
): void {
  const hasOrigin = (info & BIT8) !== 0;
  const hasRightOrigin = (info & BIT7) !== 0;
  const hasParentSub = (info & BIT6) !== 0;
  const cantCopyParentInfo = !hasOrigin && !hasRightOrigin;

  if (hasOrigin) {
    encoding.writeVarUint(encoder, decoding.readVarUint(decoder)); // origin client
    encoding.writeVarUint(encoder, decoding.readVarUint(decoder)); // origin clock
  }
  if (hasRightOrigin) {
    encoding.writeVarUint(encoder, decoding.readVarUint(decoder)); // right origin client
    encoding.writeVarUint(encoder, decoding.readVarUint(decoder)); // right origin clock
  }
  if (cantCopyParentInfo) {
    const parentInfo = decoding.readVarUint(decoder);
    encoding.writeVarUint(encoder, parentInfo);
    if (parentInfo === 1) {
      encoding.writeVarString(encoder, transformString(decoding.readVarString(decoder)));
    } else {
      // parent is an item ID
      encoding.writeVarUint(encoder, decoding.readVarUint(decoder)); // parent client
      encoding.writeVarUint(encoder, decoding.readVarUint(decoder)); // parent clock
    }
    if (hasParentSub) {
      encoding.writeVarString(encoder, transformString(decoding.readVarString(decoder)));
    }
  }
}

// ── Core: strip content from a V1 update ────────────────────────────────────

function hasEncryptableContent(contentRef: number): boolean {
  return (
    contentRef !== CONTENT_DELETED &&
    contentRef !== CONTENT_TYPE &&
    contentRef !== 0 && // GC
    contentRef !== 10 // Skip
  );
}

/**
 * Parse a Y.js V1 update and separate CRDT metadata from content.
 *
 * Returns a structure update (valid V1 with placeholder content) and an array
 * of content entries that can be encrypted into a sidecar.
 */
export function stripContent(v1Update: Uint8Array): StrippedUpdate {
  const decoder = decoding.createDecoder(v1Update);
  const encoder = encoding.createEncoder();
  const entries: ContentEntry[] = [];
  const dictionary: MetadataDictionary = new Map();
  const origToToken = new Map<string, string>();

  function replaceString(original: string): string {
    let token = origToToken.get(original);
    if (!token) {
      token = opaqueToken(original);
      origToToken.set(original, token);
      dictionary.set(token, original);
    }
    return token;
  }

  // ── Struct section ──────────────────────────────────────────────────────
  const numClients = decoding.readVarUint(decoder);
  encoding.writeVarUint(encoder, numClients);

  for (let c = 0; c < numClients; c++) {
    const numStructs = decoding.readVarUint(decoder);
    encoding.writeVarUint(encoder, numStructs);

    const clientId = decoding.readVarUint(decoder);
    encoding.writeVarUint(encoder, clientId);

    let clock = decoding.readVarUint(decoder);
    encoding.writeVarUint(encoder, clock);

    for (let s = 0; s < numStructs; s++) {
      const info = decoding.readUint8(decoder);
      encoding.writeUint8(encoder, info);

      const contentRef = info & BITS5;

      // GC (ref 0)
      if (contentRef === 0) {
        const len = decoding.readVarUint(decoder);
        encoding.writeVarUint(encoder, len);
        clock += len;
        continue;
      }

      // Skip (ref 10)
      if (contentRef === 10) {
        const len = decoding.readVarUint(decoder);
        encoding.writeVarUint(encoder, len);
        clock += len;
        continue;
      }

      // Item — copy CRDT metadata (with string hashing)
      copyItemMetadata(decoder, encoder, info, replaceString);

      // Content — either strip or copy verbatim
      if (hasEncryptableContent(contentRef)) {
        const { data, itemLength } = readContentRawBytes(decoder, contentRef);
        entries.push({ clientId, clock, contentRef, data });
        writePlaceholderContent(encoder, contentRef, itemLength);
        clock += itemLength;
      } else if (contentRef === CONTENT_TYPE) {
        // Hash XML tag names while keeping typeRef verbatim
        const typeRef = decoding.readVarUint(decoder);
        encoding.writeVarUint(encoder, typeRef);
        if (typeRef === 3 || typeRef === 5) {
          encoding.writeVarString(encoder, replaceString(decoding.readVarString(decoder)));
        }
        clock += 1;
      } else {
        // ContentDeleted — copy raw bytes
        const { data, itemLength } = readContentRawBytes(decoder, contentRef);
        encoding.writeUint8Array(encoder, data);
        clock += itemLength;
      }
    }
  }

  // ── Delete set — copy verbatim ──────────────────────────────────────────
  const remaining = decoder.arr.slice(decoder.pos);
  encoding.writeUint8Array(encoder, remaining);

  return {
    update: encoding.toUint8Array(encoder),
    sidecar: { entries, dictionary },
  };
}

/**
 * Restore original content into a structure update using sidecar entries.
 *
 * Takes a V1 structure update (with placeholder content) and the original
 * content entries, and produces the original cleartext V1 update.
 */
export function restoreContent(
  structureUpdate: Uint8Array,
  sidecar: Sidecar,
): Uint8Array {
  const entryMap = buildSidecarMap(sidecar.entries);
  const decoder = decoding.createDecoder(structureUpdate);
  const encoder = encoding.createEncoder();
  const reverseTransform = (token: string) => sidecar.dictionary.get(token) ?? token;

  // ── Struct section ──────────────────────────────────────────────────────
  const numClients = decoding.readVarUint(decoder);
  encoding.writeVarUint(encoder, numClients);

  for (let c = 0; c < numClients; c++) {
    const numStructs = decoding.readVarUint(decoder);
    encoding.writeVarUint(encoder, numStructs);

    const clientId = decoding.readVarUint(decoder);
    encoding.writeVarUint(encoder, clientId);

    let clock = decoding.readVarUint(decoder);
    encoding.writeVarUint(encoder, clock);

    for (let s = 0; s < numStructs; s++) {
      const info = decoding.readUint8(decoder);
      encoding.writeUint8(encoder, info);

      const contentRef = info & BITS5;

      // GC
      if (contentRef === 0) {
        const len = decoding.readVarUint(decoder);
        encoding.writeVarUint(encoder, len);
        clock += len;
        continue;
      }

      // Skip
      if (contentRef === 10) {
        const len = decoding.readVarUint(decoder);
        encoding.writeVarUint(encoder, len);
        clock += len;
        continue;
      }

      // Item — copy CRDT metadata (with token reversal)
      copyItemMetadata(decoder, encoder, info, reverseTransform);

      const entry = entryMap.get(sidecarKey(clientId, clock));

      if (entry && hasEncryptableContent(contentRef)) {
        // Skip placeholder content in the structure update
        const itemLength = skipContent(decoder, contentRef);
        // Write original content from sidecar
        encoding.writeUint8Array(encoder, entry.data);
        clock += itemLength;
      } else if (contentRef === CONTENT_TYPE) {
        // Restore XML tag names from dictionary
        const typeRef = decoding.readVarUint(decoder);
        encoding.writeVarUint(encoder, typeRef);
        if (typeRef === 3 || typeRef === 5) {
          encoding.writeVarString(encoder, reverseTransform(decoding.readVarString(decoder)));
        }
        clock += 1;
      } else {
        // ContentDeleted or no sidecar entry — copy verbatim
        const { data, itemLength } = readContentRawBytes(decoder, contentRef);
        encoding.writeUint8Array(encoder, data);
        clock += itemLength;
      }
    }
  }

  // ── Delete set — copy verbatim ──────────────────────────────────────────
  const remaining = decoder.arr.slice(decoder.pos);
  encoding.writeUint8Array(encoder, remaining);

  return encoding.toUint8Array(encoder);
}

// ── High-level API ──────────────────────────────────────────────────────────

export type ContentEncryptedUpdate = {
  /** V1 update with placeholder content (valid Y.js update, CRDT-operable) */
  structureUpdate: Uint8Array;
  /** AES-GCM encrypted sidecar containing original content entries */
  encryptedSidecar: EncryptedBinary;
};

/**
 * Encrypt the content of a Y.js update while preserving CRDT metadata.
 *
 * Accepts either V1 or V2 updates (auto-detected via the `version` field).
 * The returned structure update is always V1 format.
 *
 * The structure update is a valid Y.js V1 update that the server can merge,
 * sync, and store. The encrypted sidecar contains the original content
 * encrypted with AES-256-GCM.
 */
export async function encryptUpdateContent(
  key: CryptoKey,
  update: Uint8Array,
  version: 1 | 2 = 1,
): Promise<ContentEncryptedUpdate> {
  const v1 = version === 2 ? Y.convertUpdateFormatV2ToV1(update) : update;
  const { update: structureUpdate, sidecar } = stripContent(v1);
  const sidecarBytes = encodeSidecar(sidecar);
  const encryptedSidecar = await encryptUpdate(key, sidecarBytes);
  return { structureUpdate, encryptedSidecar };
}

/**
 * Decrypt a content-encrypted update, restoring the original Y.js update.
 *
 * Returns a V1 update by default. Pass `outputVersion: 2` to get a V2 update.
 */
export async function decryptUpdateContent(
  key: CryptoKey,
  encrypted: ContentEncryptedUpdate,
  outputVersion: 1 | 2 = 1,
): Promise<Uint8Array> {
  const sidecarBytes = await decryptUpdate(key, encrypted.encryptedSidecar);
  const sidecar = decodeSidecar(sidecarBytes);
  const v1 = restoreContent(encrypted.structureUpdate, sidecar);
  return outputVersion === 2 ? Y.convertUpdateFormatV1ToV2(v1) : v1;
}

/**
 * Decrypt a structure update + multiple encrypted sidecars back to a plain
 * Y.js update. Used for stored documents and milestones where the server
 * may have accumulated multiple sidecars over time.
 */
export async function decryptContentPayload(
  key: CryptoKey,
  structureUpdate: Uint8Array,
  encryptedSidecars: EncryptedBinary[],
  outputVersion: 1 | 2 = 1,
): Promise<Uint8Array> {
  const sidecars: Sidecar[] = [];
  for (const encrypted of encryptedSidecars) {
    const bytes = await decryptUpdate(key, encrypted);
    sidecars.push(decodeSidecar(bytes));
  }
  const v1 = restoreContent(structureUpdate, mergeSidecars(sidecars));
  return outputVersion === 2 ? Y.convertUpdateFormatV1ToV2(v1) : v1;
}

/**
 * Encrypt a V2 update into a content-encrypted payload suitable for storage
 * or milestone creation. Returns the binary-encoded payload.
 */
export async function encryptToContentPayload(
  key: CryptoKey,
  v2Update: Uint8Array,
): Promise<Uint8Array> {
  const v1 = Y.convertUpdateFormatV2ToV1(v2Update);
  const { structureUpdate, encryptedSidecar } = await encryptUpdateContent(key, v1, 1);
  return encodeContentEncryptedPayload({
    structureUpdate,
    encryptedSidecars: [encryptedSidecar],
  });
}

/**
 * Compact multiple encrypted sidecars into a single one by decrypting,
 * deduplicating entries by (clientId, clock), and re-encrypting.
 *
 * Returns null if there are 0 or 1 sidecars (nothing to compact).
 */
export async function compactSidecars(
  key: CryptoKey,
  sidecars: EncryptedBinary[],
): Promise<IndexedSidecar | null> {
  if (sidecars.length <= 1) return null;

  const decoded: Sidecar[] = [];
  for (const sidecar of sidecars) {
    const bytes = await decryptUpdate(key, sidecar);
    decoded.push(decodeSidecar(bytes));
  }
  const combined = mergeSidecars(decoded);

  // Deduplicate entries by (clientId, clock)
  const deduped = new Map<string, ContentEntry>();
  for (const entry of combined.entries) {
    deduped.set(`${entry.clientId}:${entry.clock}`, entry);
  }

  const merged = [...deduped.values()];
  const compactedBytes = encodeSidecar({ entries: merged, dictionary: combined.dictionary });
  const encrypted = await encryptUpdate(key, compactedBytes);
  const index = buildSidecarIndex(merged);

  return { encrypted, index };
}
