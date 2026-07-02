/**
 * Content-level encryption for Y.js updates.
 *
 * Transforms Y.js updates to separate CRDT metadata (kept in plaintext
 * as a valid Y.js update) from document content (encrypted in a sidecar).
 *
 * Works natively with both V1 and V2 update formats via Y.js's abstract
 * UpdateDecoder/UpdateEncoder interface. Structure updates are always
 * output in V2 format for zero-conversion storage and sync.
 *
 * The server can merge, sync, and store the structure update normally because
 * all CRDT metadata (client IDs, clocks, origins, parent refs, delete sets)
 * remains in plaintext. Only user-authored content (text, embeds, format
 * values, JSON, binary data) is encrypted.
 */

import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { digest as sha256 } from "lib0/hash/sha256";
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

// ── Metadata string tokenization ───────────────────────────────────────────
//
// Metadata strings (map keys, format keys) appear in the plaintext structure
// update and would otherwise leak field names to the server. They are replaced
// by opaque tokens; the token→original mapping lives in the encrypted sidecar
// dictionary, so only key holders can reverse it.
//
// The token MUST be a deterministic function of the original (the same map key
// must always produce the same token, or the server can't merge edits to that
// key) but MUST NOT be guessable by the server. A keyed PRF (HMAC-SHA256 over
// the document key) satisfies both: deterministic per document, and
// unguessable without the key — unlike an unkeyed hash, which the server can
// brute-force against common field names ("title", "body", ...).

const utf8Encoder = new TextEncoder();

/** SHA-256 block size in bytes. */
const HMAC_BLOCK_SIZE = 64;
const TOKEN_LABEL = "teleportal:metadata-token:v1:";
/** Truncate the PRF output to 128 bits — ample to avoid metadata-key collisions. */
const TOKEN_BYTES = 16;

const HEX: string[] = /* @__PURE__ */ (() => {
  const t = Array.from<string>({ length: 256 });
  for (let i = 0; i < 256; i++) t[i] = i.toString(16).padStart(2, "0");
  return t;
})();

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += HEX[bytes[i]];
  return s;
}

/**
 * Build a keyed, deterministic tokenizer for metadata strings from raw key
 * bytes. Domain-separated by a fixed label so it never collides with the
 * AES-GCM use of the same key material.
 */
export function createKeyedTokenizer(keyBytes: Uint8Array): (str: string) => string {
  const label = utf8Encoder.encode(TOKEN_LABEL);

  let key = keyBytes;
  if (key.length > HMAC_BLOCK_SIZE) key = sha256(key);
  const ipadPrefix = new Uint8Array(HMAC_BLOCK_SIZE);
  const opad = new Uint8Array(HMAC_BLOCK_SIZE + 32);
  for (let i = 0; i < HMAC_BLOCK_SIZE; i++) {
    const b = i < key.length ? key[i] : 0;
    ipadPrefix[i] = b ^ 0x36;
    opad[i] = b ^ 0x5c;
  }

  // Cache previous results — metadata key names ("title", "body", etc.) repeat
  // across every edit, so this avoids redundant SHA-256 computations. The cache
  // lives as long as the tokenizer (which lives as long as the EncryptionClient).
  const cache = new Map<string, string>();

  // Pre-allocate a reusable ipad buffer to avoid allocating a new Uint8Array on
  // every call. It grows only when a larger input is encountered.
  const ipadFixedLen = HMAC_BLOCK_SIZE + label.length;
  let ipad = new Uint8Array(ipadFixedLen + 128); // start with room for 128-byte strings
  // Stamp the constant prefix + label into the initial buffer
  ipad.set(ipadPrefix);
  ipad.set(label, HMAC_BLOCK_SIZE);

  return (str: string) => {
    const cached = cache.get(str);
    if (cached !== undefined) return cached;

    const msgBytes = utf8Encoder.encode(str);
    const needed = ipadFixedLen + msgBytes.length;
    if (ipad.length < needed) {
      // Grow to at least 2x to amortize future resizes
      ipad = new Uint8Array(Math.max(needed, ipad.length * 2));
      // Re-stamp the constant prefix + label into the new buffer
      ipad.set(ipadPrefix);
      ipad.set(label, HMAC_BLOCK_SIZE);
    }
    // Only the variable message portion needs to be written each call
    ipad.set(msgBytes, ipadFixedLen);
    // sha256 reads exactly `needed` bytes, so pass a subarray of the right length
    opad.set(sha256(ipad.subarray(0, needed)), HMAC_BLOCK_SIZE);
    const result = toHex(sha256(opad).subarray(0, TOKEN_BYTES));
    cache.set(str, result);
    return result;
  };
}

/**
 * Fallback unkeyed tokenizer. Deterministic but guessable — used only when
 * `stripContent` is called without a key (tests, structural tooling). The
 * production path (`encryptUpdateContent`) always supplies a keyed tokenizer.
 */
function unkeyedToken(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

// ── Sidecar types ───────────────────────────────────────────────────────────

type MetadataDictionary = Map<string, string>;

export type ContentEntry = {
  clientId: number;
  clock: number;
  contentRef: number;
  data: Uint8Array;
  /**
   * Number of clocks this content item spans ([clock, clock + itemLength)).
   * Stored explicitly so range lookups and overlap checks never re-parse the
   * (potentially multi-byte) content data to recover its length.
   */
  itemLength: number;
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
  hash: Uint8Array;
};

export function hashSidecar(encrypted: EncryptedBinary): Uint8Array {
  return sha256(encrypted);
}

export function buildSidecarIndex(entries: ContentEntry[]): SidecarIndex {
  const ranges = new Map<number, { min: number; max: number }>();
  for (const entry of entries) {
    // The entry covers [clock, clock + itemLength); record the inclusive end so
    // sidecarOverlapsDiff doesn't drop a multi-clock item for a tail diff.
    const endClock = entry.clock + entry.itemLength - 1;
    const existing = ranges.get(entry.clientId);
    if (existing) {
      existing.min = Math.min(existing.min, entry.clock);
      existing.max = Math.max(existing.max, endClock);
    } else {
      ranges.set(entry.clientId, { min: entry.clock, max: endClock });
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
//     [itemLengths as UintOptRle bytes (varUint8Array)]
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

      const clockEnc = new encoding.IntDiffOptRleEncoder();
      for (const e of group.entries) clockEnc.write(e.clock);
      encoding.writeVarUint8Array(encoder, clockEnc.toUint8Array());

      const refEnc = new encoding.UintOptRleEncoder();
      for (const e of group.entries) refEnc.write(e.contentRef);
      encoding.writeVarUint8Array(encoder, refEnc.toUint8Array());

      const itemLenEnc = new encoding.UintOptRleEncoder();
      for (const e of group.entries) itemLenEnc.write(e.itemLength);
      encoding.writeVarUint8Array(encoder, itemLenEnc.toUint8Array());

      const lenEnc = new encoding.UintOptRleEncoder();
      let totalDataLen = 0;
      for (const e of group.entries) {
        lenEnc.write(e.data.length);
        totalDataLen += e.data.length;
      }
      encoding.writeVarUint8Array(encoder, lenEnc.toUint8Array());

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
    const itemLenDec = new decoding.UintOptRleDecoder(decoding.readVarUint8Array(decoder));
    const lenDec = new decoding.UintOptRleDecoder(decoding.readVarUint8Array(decoder));

    const totalDataLen = decoding.readVarUint(decoder);
    const allData = decoding.readUint8Array(decoder, totalDataLen);

    let dataOffset = 0;
    for (let i = 0; i < numEntries; i++) {
      const clock = clockDec.read();
      const contentRef = refDec.read();
      const itemLength = itemLenDec.read();
      const dataLen = lenDec.read();
      const data = allData.subarray(dataOffset, dataOffset + dataLen);
      dataOffset += dataLen;

      entries.push({ clientId, clock, contentRef, data, itemLength });
    }
  }

  return { entries, dictionary };
}

export function mergeSidecars(sidecars: Sidecar[]): Sidecar {
  const entries: ContentEntry[] = [];
  const dictionary: MetadataDictionary = new Map();
  for (const s of sidecars) {
    for (const e of s.entries) entries.push(e);
    for (const [token, original] of s.dictionary) {
      dictionary.set(token, original);
    }
  }
  return { entries, dictionary };
}

// ── Sidecar lookup ──────────────────────────────────────────────────────────

function buildSidecarMap(entries: ContentEntry[]): Map<number, Map<number, ContentEntry>> {
  const map = new Map<number, Map<number, ContentEntry>>();
  for (const entry of entries) {
    let clientMap = map.get(entry.clientId);
    if (!clientMap) {
      clientMap = new Map();
      map.set(entry.clientId, clientMap);
    }
    clientMap.set(entry.clock, entry);
  }
  return map;
}

/**
 * Group entries by client, each list sorted ascending by clock, for locating
 * the entry whose `[clock, clock + itemLength)` range contains a target clock.
 */
function buildSidecarRangeIndex(entries: ContentEntry[]): Map<number, ContentEntry[]> {
  const byClient = new Map<number, ContentEntry[]>();
  for (const entry of entries) {
    let list = byClient.get(entry.clientId);
    if (!list) {
      list = [];
      byClient.set(entry.clientId, list);
    }
    list.push(entry);
  }
  for (const list of byClient.values()) list.sort((a, b) => a.clock - b.clock);
  return byClient;
}

/** Find the entry whose clock range contains `clock` (entries sorted ascending). */
function findContainingEntry(
  entries: ContentEntry[] | undefined,
  clock: number,
): ContentEntry | undefined {
  if (!entries) return undefined;
  for (const entry of entries) {
    if (entry.clock > clock) break;
    if (clock < entry.clock + entry.itemLength) {
      return entry;
    }
  }
  return undefined;
}

// ── Abstract decoder/encoder types ────────────────────────────────────────

type UpdateDecoder = Y.UpdateDecoderV1 | Y.UpdateDecoderV2;
type UpdateEncoder = Y.UpdateEncoderV1 | Y.UpdateEncoderV2;

// ── Content readers (abstract decoder → canonical sidecar bytes) ──────────

function readContentToSidecar(
  decoder: UpdateDecoder,
  contentRef: number,
): { data: Uint8Array; itemLength: number } {
  const enc = encoding.createEncoder();
  let itemLength: number;

  switch (contentRef) {
    case CONTENT_STRING: {
      const str = decoder.readString();
      encoding.writeVarString(enc, str);
      itemLength = str.length;
      break;
    }
    case CONTENT_JSON: {
      const count = decoder.readLen();
      encoding.writeVarUint(enc, count);
      for (let i = 0; i < count; i++) {
        encoding.writeVarString(enc, decoder.readString());
      }
      itemLength = count;
      break;
    }
    case CONTENT_BINARY: {
      encoding.writeVarUint8Array(enc, decoder.readBuf());
      itemLength = 1;
      break;
    }
    case CONTENT_EMBED: {
      const embed = decoder.readJSON();
      encoding.writeVarString(enc, JSON.stringify(embed));
      itemLength = 1;
      break;
    }
    case CONTENT_FORMAT: {
      const key = decoder.readKey();
      const value = decoder.readJSON();
      encoding.writeVarString(enc, key);
      encoding.writeVarString(enc, JSON.stringify(value));
      itemLength = 1;
      break;
    }
    case CONTENT_ANY: {
      const count = decoder.readLen();
      encoding.writeVarUint(enc, count);
      for (let i = 0; i < count; i++) {
        encoding.writeAny(enc, decoder.readAny());
      }
      itemLength = count;
      break;
    }
    case CONTENT_DOC: {
      const guid = decoder.readString();
      const opts = decoder.readAny();
      encoding.writeVarString(enc, guid);
      encoding.writeAny(enc, opts);
      itemLength = 1;
      break;
    }
    default:
      throw new Error(`Unknown content ref: ${contentRef}`);
  }

  return { data: encoding.toUint8Array(enc), itemLength };
}

// ── Content skip (advance decoder, return item length) ────────────────────

function skipContent(decoder: UpdateDecoder, contentRef: number): number {
  switch (contentRef) {
    case CONTENT_DELETED:
      return decoder.readLen();
    case CONTENT_JSON: {
      const count = decoder.readLen();
      for (let i = 0; i < count; i++) decoder.readString();
      return count;
    }
    case CONTENT_BINARY:
      decoder.readBuf();
      return 1;
    case CONTENT_STRING:
      return decoder.readString().length;
    case CONTENT_EMBED:
      decoder.readJSON();
      return 1;
    case CONTENT_FORMAT:
      decoder.readKey();
      decoder.readJSON();
      return 1;
    case CONTENT_TYPE: {
      const typeRef = decoder.readTypeRef();
      if (typeRef === 3 || typeRef === 5) decoder.readKey();
      return 1;
    }
    case CONTENT_ANY: {
      const count = decoder.readLen();
      for (let i = 0; i < count; i++) decoder.readAny();
      return count;
    }
    case CONTENT_DOC:
      decoder.readString();
      decoder.readAny();
      return 1;
    default:
      throw new Error(`Unknown content ref: ${contentRef}`);
  }
}

// ── Content writer (canonical sidecar bytes → abstract encoder) ───────────

function writeContentFromSidecar(
  encoder: UpdateEncoder,
  contentRef: number,
  data: Uint8Array,
): void {
  const dec = decoding.createDecoder(data);

  switch (contentRef) {
    case CONTENT_STRING:
      encoder.writeString(decoding.readVarString(dec));
      break;
    case CONTENT_JSON: {
      const count = decoding.readVarUint(dec);
      encoder.writeLen(count);
      for (let i = 0; i < count; i++) {
        encoder.writeString(decoding.readVarString(dec));
      }
      break;
    }
    case CONTENT_BINARY:
      encoder.writeBuf(decoding.readVarUint8Array(dec));
      break;
    case CONTENT_EMBED:
      encoder.writeJSON(JSON.parse(decoding.readVarString(dec)));
      break;
    case CONTENT_FORMAT: {
      const key = decoding.readVarString(dec);
      const value = JSON.parse(decoding.readVarString(dec));
      encoder.writeKey(key);
      encoder.writeJSON(value);
      break;
    }
    case CONTENT_ANY: {
      const count = decoding.readVarUint(dec);
      encoder.writeLen(count);
      for (let i = 0; i < count; i++) {
        encoder.writeAny(decoding.readAny(dec));
      }
      break;
    }
    case CONTENT_DOC:
      encoder.writeString(decoding.readVarString(dec));
      encoder.writeAny(decoding.readAny(dec));
      break;
    default:
      throw new Error(`Unknown content ref: ${contentRef}`);
  }
}

/**
 * Write the tail of a sidecar entry's content, starting at `offset` clocks in.
 *
 * Y.diffUpdateV2 slices a multi-clock content item when the requesting peer
 * already holds a prefix; the resulting struct represents `[offset, length)` of
 * the original item. We mirror that slice so the restored content length
 * matches the placeholder's. Length-1 content types are never sliced (offset is
 * always 0) and fall through to the verbatim writer.
 */
function writeSlicedContentFromSidecar(
  encoder: UpdateEncoder,
  contentRef: number,
  data: Uint8Array,
  offset: number,
): void {
  if (offset === 0) {
    writeContentFromSidecar(encoder, contentRef, data);
    return;
  }
  const dec = decoding.createDecoder(data);
  switch (contentRef) {
    case CONTENT_STRING:
      encoder.writeString(decoding.readVarString(dec).slice(offset));
      break;
    case CONTENT_JSON: {
      const count = decoding.readVarUint(dec);
      for (let i = 0; i < offset; i++) decoding.readVarString(dec);
      const remaining = count - offset;
      encoder.writeLen(remaining);
      for (let i = 0; i < remaining; i++) encoder.writeString(decoding.readVarString(dec));
      break;
    }
    case CONTENT_ANY: {
      const count = decoding.readVarUint(dec);
      for (let i = 0; i < offset; i++) decoding.readAny(dec);
      const remaining = count - offset;
      encoder.writeLen(remaining);
      for (let i = 0; i < remaining; i++) encoder.writeAny(decoding.readAny(dec));
      break;
    }
    default:
      throw new Error(`restoreContent: cannot slice content ref ${contentRef} at offset ${offset}`);
  }
}

// ── Placeholder content writer (abstract encoder) ─────────────────────────

function writePlaceholderContent(
  encoder: UpdateEncoder,
  contentRef: number,
  itemLength: number,
): void {
  switch (contentRef) {
    case CONTENT_DELETED:
      encoder.writeLen(itemLength);
      break;
    case CONTENT_JSON:
      encoder.writeLen(itemLength);
      for (let i = 0; i < itemLength; i++) encoder.writeString("null");
      break;
    case CONTENT_BINARY:
      encoder.writeBuf(new Uint8Array(0));
      break;
    case CONTENT_STRING:
      encoder.writeString("\0".repeat(itemLength));
      break;
    case CONTENT_EMBED:
      encoder.writeJSON(null);
      break;
    case CONTENT_FORMAT:
      encoder.writeKey("\0");
      encoder.writeJSON(null);
      break;
    case CONTENT_TYPE:
      throw new Error("ContentType should be copied verbatim, not replaced");
    case CONTENT_ANY:
      encoder.writeLen(itemLength);
      for (let i = 0; i < itemLength; i++) encoder.writeAny(null);
      break;
    case CONTENT_DOC:
      encoder.writeString("\0");
      encoder.writeAny(null);
      break;
    default:
      throw new Error(`Unknown content ref: ${contentRef}`);
  }
}

// ── CRDT metadata copier (abstract decoder/encoder) ───────────────────────

function copyItemMetadata(
  decoder: UpdateDecoder,
  encoder: UpdateEncoder,
  info: number,
  transformString: (s: string) => string,
): void {
  const hasOrigin = (info & BIT8) !== 0;
  const hasRightOrigin = (info & BIT7) !== 0;
  const hasParentSub = (info & BIT6) !== 0;
  const cantCopyParentInfo = !hasOrigin && !hasRightOrigin;

  if (hasOrigin) {
    encoder.writeLeftID(decoder.readLeftID());
  }
  if (hasRightOrigin) {
    encoder.writeRightID(decoder.readRightID());
  }
  if (cantCopyParentInfo) {
    const isYKey = decoder.readParentInfo();
    encoder.writeParentInfo(isYKey);
    if (isYKey) {
      encoder.writeString(transformString(decoder.readString()));
    } else {
      encoder.writeLeftID(decoder.readLeftID());
    }
    if (hasParentSub) {
      encoder.writeString(transformString(decoder.readString()));
    }
  }
}

/** Advance the decoder past item metadata without writing (read-only skip). */
function skipItemMetadata(decoder: UpdateDecoder, info: number): void {
  const hasOrigin = (info & BIT8) !== 0;
  const hasRightOrigin = (info & BIT7) !== 0;
  const hasParentSub = (info & BIT6) !== 0;

  if (hasOrigin) decoder.readLeftID();
  if (hasRightOrigin) decoder.readRightID();
  if (!hasOrigin && !hasRightOrigin) {
    const isYKey = decoder.readParentInfo();
    if (isYKey) decoder.readString();
    else decoder.readLeftID();
    if (hasParentSub) decoder.readString();
  }
}

// ── Delete set copier (abstract DS decoder/encoder) ───────────────────────

function copyDeleteSet(decoder: UpdateDecoder, encoder: UpdateEncoder): void {
  const numClients = decoding.readVarUint(decoder.restDecoder);
  encoding.writeVarUint(encoder.restEncoder, numClients);

  for (let i = 0; i < numClients; i++) {
    decoder.resetDsCurVal();
    encoder.resetDsCurVal();

    const client = decoding.readVarUint(decoder.restDecoder);
    encoding.writeVarUint(encoder.restEncoder, client);

    const numDeletes = decoding.readVarUint(decoder.restDecoder);
    encoding.writeVarUint(encoder.restEncoder, numDeletes);

    for (let j = 0; j < numDeletes; j++) {
      encoder.writeDsClock(decoder.readDsClock());
      encoder.writeDsLen(decoder.readDsLen());
    }
  }
}

// ── Core: strip content from an update ─────────────────────────────────────

function hasEncryptableContent(contentRef: number): boolean {
  return (
    contentRef !== CONTENT_DELETED &&
    contentRef !== CONTENT_TYPE &&
    contentRef !== 0 && // GC
    contentRef !== 10 // Skip
  );
}

// ── V1 raw-byte helpers (bypass Y.js decoder/encoder entirely) ─────────────
//
// These functions operate directly on lib0 Decoder byte streams, avoiding
// Y.js's abstract decoder layer and — crucially — avoiding string/object
// allocation when we only need to advance past data or compute a length.

/** Advance past a varString without UTF-8 decoding or string allocation. */
function skipVarString(dec: decoding.Decoder): void {
  // Cannot use `dec.pos += readVarUint(dec)` — JS evaluates `dec.pos`
  // before `readVarUint` mutates it, discarding the position advance.
  const len = decoding.readVarUint(dec);
  dec.pos += len;
}

/** Advance past a varUint without computing its value. */
function skipVarUint(dec: decoding.Decoder): void {
  while (dec.arr[dec.pos++] >= 0x80) {}
}

/** Advance past a lib0 `any` value without allocating JS objects. */
function skipAny(dec: decoding.Decoder): void {
  const type = dec.arr[dec.pos++];
  switch (type) {
    case 127: // undefined
    case 126: // null
    case 121: // false
    case 120: // true
      break;
    case 125: // integer (varInt — same continuation encoding as varUint)
      while (dec.arr[dec.pos++] >= 0x80) {}
      break;
    case 124: // float32
      dec.pos += 4;
      break;
    case 123: // float64
      dec.pos += 8;
      break;
    case 122: // BigInt64
      dec.pos += 8;
      break;
    case 119: // string
      skipVarString(dec);
      break;
    case 118: {
      // object
      let len = decoding.readVarUint(dec);
      while (len-- > 0) {
        skipVarString(dec);
        skipAny(dec);
      }
      break;
    }
    case 117: {
      // array
      let len = decoding.readVarUint(dec);
      while (len-- > 0) skipAny(dec);
      break;
    }
    case 116: // Uint8Array
      {
        const n = decoding.readVarUint(dec);
        dec.pos += n;
      }
      break;
  }
}

/**
 * Compute the UTF-16 `.length` of a varString without creating a JS string.
 * For ASCII-only content (the common case), length === byteLength.
 */
function readVarStringLength(dec: decoding.Decoder): number {
  const byteLen = decoding.readVarUint(dec);
  const start = dec.pos;
  const end = start + byteLen;
  const arr = dec.arr;
  dec.pos = end;

  let i = start;
  for (; i < end; i++) {
    if (arr[i] >= 0x80) break;
  }
  if (i === end) return byteLen;

  let utf16Len = i - start;
  while (i < end) {
    const b = arr[i];
    if (b < 0x80) {
      i++;
      utf16Len++;
    } else if (b < 0xe0) {
      i += 2;
      utf16Len++;
    } else if (b < 0xf0) {
      i += 3;
      utf16Len++;
    } else {
      i += 4;
      utf16Len += 2;
    }
  }
  return utf16Len;
}

function skipItemMetadataV1Raw(dec: decoding.Decoder, info: number): void {
  const hasOrigin = (info & BIT8) !== 0;
  const hasRightOrigin = (info & BIT7) !== 0;
  const hasParentSub = (info & BIT6) !== 0;
  if (hasOrigin) {
    skipVarUint(dec);
    skipVarUint(dec);
  }
  if (hasRightOrigin) {
    skipVarUint(dec);
    skipVarUint(dec);
  }
  if (!hasOrigin && !hasRightOrigin) {
    const isYKey = decoding.readVarUint(dec) === 1;
    if (isYKey) skipVarString(dec);
    else {
      skipVarUint(dec);
      skipVarUint(dec);
    }
    if (hasParentSub) skipVarString(dec);
  }
}

function skipContentV1Raw(dec: decoding.Decoder, contentRef: number): number {
  switch (contentRef) {
    case CONTENT_DELETED:
      return decoding.readVarUint(dec);
    case CONTENT_JSON: {
      const count = decoding.readVarUint(dec);
      for (let i = 0; i < count; i++) skipVarString(dec);
      return count;
    }
    case CONTENT_BINARY:
      {
        const n = decoding.readVarUint(dec);
        dec.pos += n;
      }
      return 1;
    case CONTENT_STRING:
      return readVarStringLength(dec);
    case CONTENT_EMBED:
      skipVarString(dec);
      return 1;
    case CONTENT_FORMAT:
      skipVarString(dec);
      skipVarString(dec);
      return 1;
    case CONTENT_TYPE: {
      const typeRef = decoding.readVarUint(dec);
      if (typeRef === 3 || typeRef === 5) skipVarString(dec);
      return 1;
    }
    case CONTENT_ANY: {
      const count = decoding.readVarUint(dec);
      for (let i = 0; i < count; i++) skipAny(dec);
      return count;
    }
    case CONTENT_DOC:
      skipVarString(dec);
      skipAny(dec);
      return 1;
    default:
      throw new Error(`Unknown content ref: ${contentRef}`);
  }
}

// Pre-allocated "null" varString bytes: varUint(4) + "null" = [4, 110, 117, 108, 108]
const NULL_VARSTRING = /* @__PURE__ */ (() => {
  const e = encoding.createEncoder();
  encoding.writeVarString(e, "null");
  return encoding.toUint8Array(e);
})();
// Pre-allocated "\0" varString bytes: varUint(1) + 0x00 = [1, 0]
const NUL_VARSTRING = new Uint8Array([1, 0]);
// Pre-allocated null any byte: type 126
const NULL_ANY = new Uint8Array([126]);

function writePlaceholderContentV1Raw(
  enc: encoding.Encoder,
  contentRef: number,
  itemLength: number,
): void {
  switch (contentRef) {
    case CONTENT_JSON:
      encoding.writeVarUint(enc, itemLength);
      for (let i = 0; i < itemLength; i++) encoding.writeUint8Array(enc, NULL_VARSTRING);
      break;
    case CONTENT_BINARY:
      encoding.writeVarUint(enc, 0);
      break;
    case CONTENT_STRING:
      encoding.writeVarUint(enc, itemLength);
      encoding.writeUint8Array(enc, new Uint8Array(itemLength));
      break;
    case CONTENT_EMBED:
      encoding.writeUint8Array(enc, NULL_VARSTRING);
      break;
    case CONTENT_FORMAT:
      encoding.writeUint8Array(enc, NUL_VARSTRING);
      encoding.writeUint8Array(enc, NULL_VARSTRING);
      break;
    case CONTENT_ANY: {
      encoding.writeVarUint(enc, itemLength);
      for (let i = 0; i < itemLength; i++) encoding.writeUint8Array(enc, NULL_ANY);
      break;
    }
    case CONTENT_DOC:
      encoding.writeUint8Array(enc, NUL_VARSTRING);
      encoding.writeUint8Array(enc, NULL_ANY);
      break;
    default:
      throw new Error(`Unknown content ref: ${contentRef}`);
  }
}

function writeSlicedContentV1Raw(
  enc: encoding.Encoder,
  contentRef: number,
  data: Uint8Array,
  offset: number,
): void {
  const dec = decoding.createDecoder(data);
  switch (contentRef) {
    case CONTENT_STRING:
      encoding.writeVarString(enc, decoding.readVarString(dec).slice(offset));
      break;
    case CONTENT_JSON: {
      const count = decoding.readVarUint(dec);
      for (let i = 0; i < offset; i++) decoding.readVarString(dec);
      const remaining = count - offset;
      encoding.writeVarUint(enc, remaining);
      for (let i = 0; i < remaining; i++) encoding.writeVarString(enc, decoding.readVarString(dec));
      break;
    }
    case CONTENT_ANY: {
      const count = decoding.readVarUint(dec);
      for (let i = 0; i < offset; i++) decoding.readAny(dec);
      const remaining = count - offset;
      encoding.writeVarUint(enc, remaining);
      for (let i = 0; i < remaining; i++) encoding.writeAny(enc, decoding.readAny(dec));
      break;
    }
    default:
      throw new Error(`restoreContent: cannot slice content ref ${contentRef} at offset ${offset}`);
  }
}

/**
 * V1→V1 fast path: strip content using raw lib0 byte operations.
 * No Y.js decoder/encoder creation, no metadata tokenization,
 * no V1→V2 format conversion. Metadata bytes are copied directly.
 */
function stripContentV1Raw(update: Uint8Array): StrippedUpdate {
  const dec = decoding.createDecoder(update);
  const enc = encoding.createEncoder();
  const entries: ContentEntry[] = [];

  const numClients = decoding.readVarUint(dec);
  encoding.writeVarUint(enc, numClients);

  for (let c = 0; c < numClients; c++) {
    const numStructs = decoding.readVarUint(dec);
    encoding.writeVarUint(enc, numStructs);

    const clientId = decoding.readVarUint(dec);
    encoding.writeVarUint(enc, clientId);

    let clock = decoding.readVarUint(dec);
    encoding.writeVarUint(enc, clock);

    for (let s = 0; s < numStructs; s++) {
      const info = decoding.readUint8(dec);
      encoding.writeUint8(enc, info);

      const contentRef = info & BITS5;

      if (contentRef === 0 || contentRef === 10) {
        const start = dec.pos;
        clock += decoding.readVarUint(dec);
        encoding.writeUint8Array(enc, update.subarray(start, dec.pos));
        continue;
      }

      // Copy metadata bytes directly (no tokenization needed)
      const metaStart = dec.pos;
      skipItemMetadataV1Raw(dec, info);
      encoding.writeUint8Array(enc, update.subarray(metaStart, dec.pos));

      if (hasEncryptableContent(contentRef)) {
        const contentStart = dec.pos;
        const itemLength = skipContentV1Raw(dec, contentRef);
        entries.push({
          clientId,
          clock,
          contentRef,
          data: update.subarray(contentStart, dec.pos),
          itemLength,
        });
        writePlaceholderContentV1Raw(enc, contentRef, itemLength);
        clock += itemLength;
      } else if (contentRef === CONTENT_TYPE) {
        const start = dec.pos;
        const typeRef = decoding.readVarUint(dec);
        if (typeRef === 3 || typeRef === 5) decoding.readVarString(dec);
        encoding.writeUint8Array(enc, update.subarray(start, dec.pos));
        clock += 1;
      } else {
        const start = dec.pos;
        clock += decoding.readVarUint(dec);
        encoding.writeUint8Array(enc, update.subarray(start, dec.pos));
      }
    }
  }

  if (dec.pos < update.length) {
    encoding.writeUint8Array(enc, update.subarray(dec.pos));
  }

  return {
    update: encoding.toUint8Array(enc),
    sidecar: { entries, dictionary: new Map() },
  };
}

/**
 * V1 fast path for restoreContent: bypass Y.js decoder/encoder, work directly
 * with lib0 byte operations. Structure update must be V1 format.
 */
function restoreContentV1Raw(structureUpdate: Uint8Array, sidecar: Sidecar): Uint8Array {
  const dec = decoding.createDecoder(structureUpdate);
  const enc = encoding.createEncoder();
  const entryMap = buildSidecarMap(sidecar.entries);
  let rangeIndex: Map<number, ContentEntry[]> | undefined;

  const numClients = decoding.readVarUint(dec);
  encoding.writeVarUint(enc, numClients);

  for (let c = 0; c < numClients; c++) {
    const numStructs = decoding.readVarUint(dec);
    encoding.writeVarUint(enc, numStructs);

    const clientId = decoding.readVarUint(dec);
    encoding.writeVarUint(enc, clientId);

    let clock = decoding.readVarUint(dec);
    encoding.writeVarUint(enc, clock);

    for (let s = 0; s < numStructs; s++) {
      const info = decoding.readUint8(dec);
      encoding.writeUint8(enc, info);

      const contentRef = info & BITS5;

      if (contentRef === 0 || contentRef === 10) {
        const start = dec.pos;
        clock += decoding.readVarUint(dec);
        encoding.writeUint8Array(enc, structureUpdate.subarray(start, dec.pos));
        continue;
      }

      const metaStart = dec.pos;
      skipItemMetadataV1Raw(dec, info);
      encoding.writeUint8Array(enc, structureUpdate.subarray(metaStart, dec.pos));

      if (hasEncryptableContent(contentRef)) {
        let entry = entryMap.get(clientId)?.get(clock);
        let offset = 0;
        if (!entry) {
          rangeIndex ??= buildSidecarRangeIndex(sidecar.entries);
          const containing = findContainingEntry(rangeIndex.get(clientId), clock);
          if (containing) {
            entry = containing;
            offset = clock - containing.clock;
          }
        }
        if (!entry) {
          throw new Error(
            `restoreContent: missing sidecar entry for encryptable content ` +
              `(clientId=${clientId}, clock=${clock}, contentRef=${contentRef})`,
          );
        }
        const itemLength = skipContentV1Raw(dec, contentRef);
        if (offset === 0) {
          encoding.writeUint8Array(enc, entry.data);
        } else {
          writeSlicedContentV1Raw(enc, contentRef, entry.data, offset);
        }
        clock += itemLength;
      } else if (contentRef === CONTENT_TYPE) {
        const start = dec.pos;
        const typeRef = decoding.readVarUint(dec);
        if (typeRef === 3 || typeRef === 5) decoding.readVarString(dec);
        encoding.writeUint8Array(enc, structureUpdate.subarray(start, dec.pos));
        clock += 1;
      } else {
        const start = dec.pos;
        clock += decoding.readVarUint(dec);
        encoding.writeUint8Array(enc, structureUpdate.subarray(start, dec.pos));
      }
    }
  }

  if (dec.pos < structureUpdate.length) {
    encoding.writeUint8Array(enc, structureUpdate.subarray(dec.pos));
  }

  return encoding.toUint8Array(enc);
}

function collectAliveContentRangesV1(structureUpdate: Uint8Array): Map<number, AliveRange[]> {
  const dec = decoding.createDecoder(structureUpdate);
  const alive = new Map<number, AliveRange[]>();

  const numClients = decoding.readVarUint(dec);
  for (let c = 0; c < numClients; c++) {
    const numStructs = decoding.readVarUint(dec);
    const clientId = decoding.readVarUint(dec);
    let clock = decoding.readVarUint(dec);

    for (let s = 0; s < numStructs; s++) {
      const info = decoding.readUint8(dec);
      const contentRef = info & BITS5;

      if (contentRef === 0 || contentRef === 10) {
        clock += decoding.readVarUint(dec);
        continue;
      }

      skipItemMetadataV1Raw(dec, info);

      if (hasEncryptableContent(contentRef)) {
        const itemLength = skipContentV1Raw(dec, contentRef);
        let ranges = alive.get(clientId);
        if (!ranges) {
          ranges = [];
          alive.set(clientId, ranges);
        }
        ranges.push({ clock, length: itemLength });
        clock += itemLength;
      } else if (contentRef === CONTENT_TYPE) {
        const typeRef = decoding.readVarUint(dec);
        if (typeRef === 3 || typeRef === 5) decoding.readVarString(dec);
        clock += 1;
      } else {
        clock += decoding.readVarUint(dec);
      }
    }
  }

  return alive;
}

/**
 * Parse a Y.js update and separate CRDT metadata from content.
 *
 * Accepts V1 or V2 input (via `version` parameter, default V2).
 *
 * With a tokenizer (default or custom): outputs a V2 structure update with
 * tokenized metadata strings. Used for encryption where field names must be
 * opaque to the server.
 *
 * With `tokenize: false`: outputs a V1 structure update using a zero-copy
 * fast path — no Y.js decoder/encoder objects, no format conversion, raw
 * byte operations only. Used for unencrypted updates where content-cipher
 * is the universal format.
 */
export function stripContent(
  update: Uint8Array,
  version: 1 | 2 = 2,
  tokenize: ((str: string) => string) | false = unkeyedToken,
): StrippedUpdate {
  if (tokenize === false && version === 1) {
    return stripContentV1Raw(update);
  }
  const tokenizeFn = tokenize || unkeyedToken;

  const rawDecoder = decoding.createDecoder(update);
  const decoder: UpdateDecoder =
    version === 2 ? new Y.UpdateDecoderV2(rawDecoder) : new Y.UpdateDecoderV1(rawDecoder);
  const encoder = new Y.UpdateEncoderV2();

  const entries: ContentEntry[] = [];
  const dictionary: MetadataDictionary = new Map();
  const origToToken = new Map<string, string>();

  // V1 fast path: raw bytes in the V1 decoder use the same lib0 encoding as
  // our canonical sidecar format. Capture byte ranges directly from the
  // decoder buffer to avoid allocating an intermediate encoder per entry.
  const isV1 = version === 1;

  function replaceString(original: string): string {
    let token = origToToken.get(original);
    if (!token) {
      token = tokenizeFn(original);
      origToToken.set(original, token);
      dictionary.set(token, original);
    }
    return token;
  }

  // ── Struct section ──────────────────────────────────────────────────────
  const numClients = decoding.readVarUint(decoder.restDecoder);
  encoding.writeVarUint(encoder.restEncoder, numClients);

  for (let c = 0; c < numClients; c++) {
    const numStructs = decoding.readVarUint(decoder.restDecoder);
    encoding.writeVarUint(encoder.restEncoder, numStructs);

    const clientId = decoder.readClient();
    encoder.writeClient(clientId);

    let clock = decoding.readVarUint(decoder.restDecoder);
    encoding.writeVarUint(encoder.restEncoder, clock);

    for (let s = 0; s < numStructs; s++) {
      const info = decoder.readInfo();
      encoder.writeInfo(info);

      const contentRef = info & BITS5;

      // GC (ref 0)
      if (contentRef === 0) {
        const len = decoder.readLen();
        encoder.writeLen(len);
        clock += len;
        continue;
      }

      // Skip (ref 10) — uses restDecoder/restEncoder directly
      if (contentRef === 10) {
        const len = decoding.readVarUint(decoder.restDecoder);
        encoding.writeVarUint(encoder.restEncoder, len);
        clock += len;
        continue;
      }

      // Item — copy CRDT metadata (with string hashing)
      copyItemMetadata(decoder, encoder, info, replaceString);

      // Content — either strip or copy verbatim
      if (hasEncryptableContent(contentRef)) {
        let data: Uint8Array;
        let itemLength: number;

        if (isV1) {
          // V1 fast path: capture raw bytes from the decoder buffer.
          // For V1, all content reads go through restDecoder, and the
          // lib0 encoding format matches our canonical sidecar format.
          const startPos = rawDecoder.pos;
          itemLength = skipContent(decoder, contentRef);
          data = update.subarray(startPos, rawDecoder.pos);
        } else {
          ({ data, itemLength } = readContentToSidecar(decoder, contentRef));
        }

        entries.push({ clientId, clock, contentRef, data, itemLength });
        writePlaceholderContent(encoder, contentRef, itemLength);
        clock += itemLength;
      } else if (contentRef === CONTENT_TYPE) {
        const typeRef = decoder.readTypeRef();
        encoder.writeTypeRef(typeRef);
        if (typeRef === 3 || typeRef === 5) {
          encoder.writeKey(replaceString(decoder.readKey()));
        }
        clock += 1;
      } else {
        // ContentDeleted
        const len = decoder.readLen();
        encoder.writeLen(len);
        clock += len;
      }
    }
  }

  // ── Delete set ─────────────────────────────────────────────────────────
  copyDeleteSet(decoder, encoder);

  return {
    update: encoder.toUint8Array(),
    sidecar: { entries, dictionary },
  };
}

/**
 * Restore original content into a structure update using sidecar entries.
 *
 * Takes a structure update (with placeholder content) and the original
 * content entries, and produces the cleartext update.
 *
 * Output version defaults to V2. Pass `outputVersion: 1` for V1 output.
 *
 * When `structureVersion: 1`, uses a raw-byte fast path that bypasses
 * Y.js decoder/encoder objects entirely. Use this with structure updates
 * produced by `stripContent(..., false)`.
 */
export function restoreContent(
  structureUpdate: Uint8Array,
  sidecar: Sidecar,
  outputVersion: 1 | 2 = 2,
  structureVersion: 1 | 2 = 2,
): Uint8Array {
  if (structureVersion === 1 && outputVersion === 1) {
    return restoreContentV1Raw(structureUpdate, sidecar);
  }
  const entryMap = buildSidecarMap(sidecar.entries);
  let rangeIndex: Map<number, ContentEntry[]> | undefined;
  const rawDecoder = decoding.createDecoder(structureUpdate);
  const decoder = new Y.UpdateDecoderV2(rawDecoder);
  const encoder: UpdateEncoder =
    outputVersion === 2 ? new Y.UpdateEncoderV2() : new Y.UpdateEncoderV1();
  const reverseTransform = (token: string) => sidecar.dictionary.get(token) ?? token;

  // V1 fast path: sidecar data bytes match V1 encoding format exactly, so
  // we can write them directly to the V1 encoder's restEncoder without
  // decoding + re-encoding each content field.
  const v1RestEncoder = outputVersion === 1 ? (encoder as any).restEncoder : null;

  // ── Struct section ──────────────────────────────────────────────────────
  const numClients = decoding.readVarUint(decoder.restDecoder);
  encoding.writeVarUint(encoder.restEncoder, numClients);

  for (let c = 0; c < numClients; c++) {
    const numStructs = decoding.readVarUint(decoder.restDecoder);
    encoding.writeVarUint(encoder.restEncoder, numStructs);

    const clientId = decoder.readClient();
    encoder.writeClient(clientId);

    let clock = decoding.readVarUint(decoder.restDecoder);
    encoding.writeVarUint(encoder.restEncoder, clock);

    for (let s = 0; s < numStructs; s++) {
      const info = decoder.readInfo();
      encoder.writeInfo(info);

      const contentRef = info & BITS5;

      // GC
      if (contentRef === 0) {
        const len = decoder.readLen();
        encoder.writeLen(len);
        clock += len;
        continue;
      }

      // Skip
      if (contentRef === 10) {
        const len = decoding.readVarUint(decoder.restDecoder);
        encoding.writeVarUint(encoder.restEncoder, len);
        clock += len;
        continue;
      }

      // Item — copy CRDT metadata (with token reversal)
      copyItemMetadata(decoder, encoder, info, reverseTransform);

      if (hasEncryptableContent(contentRef)) {
        let entry = entryMap.get(clientId)?.get(clock);
        let offset = 0;
        if (!entry) {
          rangeIndex ??= buildSidecarRangeIndex(sidecar.entries);
          const containing = findContainingEntry(rangeIndex.get(clientId), clock);
          if (containing) {
            entry = containing;
            offset = clock - containing.clock;
          }
        }
        if (!entry) {
          throw new Error(
            `restoreContent: missing sidecar entry for encryptable content ` +
              `(clientId=${clientId}, clock=${clock}, contentRef=${contentRef})`,
          );
        }
        const itemLength = skipContent(decoder, contentRef);
        if (v1RestEncoder && offset === 0) {
          // V1 fast path: write sidecar bytes directly — the lib0 encoding
          // format in the sidecar is identical to V1 content encoding.
          encoding.writeUint8Array(v1RestEncoder, entry.data);
        } else {
          writeSlicedContentFromSidecar(encoder, contentRef, entry.data, offset);
        }
        clock += itemLength;
      } else if (contentRef === CONTENT_TYPE) {
        const typeRef = decoder.readTypeRef();
        encoder.writeTypeRef(typeRef);
        if (typeRef === 3 || typeRef === 5) {
          encoder.writeKey(reverseTransform(decoder.readKey()));
        }
        clock += 1;
      } else {
        // ContentDeleted
        const len = decoder.readLen();
        encoder.writeLen(len);
        clock += len;
      }
    }
  }

  // ── Delete set ─────────────────────────────────────────────────────────
  copyDeleteSet(decoder, encoder);

  return encoder.toUint8Array();
}

// ── High-level API ──────────────────────────────────────────────────────────

export type ContentEncryptedUpdate = {
  /** V2 update with placeholder content (valid Y.js update, CRDT-operable) */
  structureUpdate: Uint8Array;
  /** AES-GCM encrypted sidecar containing original content entries */
  encryptedSidecar: EncryptedBinary;
};

/**
 * Encrypt the content of a Y.js update while preserving CRDT metadata.
 *
 * Accepts either V1 or V2 updates via the `version` parameter (default V2).
 * The returned structure update is always V2 format.
 */
export async function encryptUpdateContent(
  key: CryptoKey,
  update: Uint8Array,
  version: 1 | 2 = 2,
): Promise<ContentEncryptedUpdate> {
  // Derive a keyed tokenizer so metadata key names are not guessable from the
  // plaintext structure update. Reverse mapping travels in the encrypted sidecar.
  const rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  const { update: structureUpdate, sidecar } = stripContent(
    update,
    version,
    createKeyedTokenizer(rawKey),
  );
  const sidecarBytes = encodeSidecar(sidecar);
  const encryptedSidecar = await encryptUpdate(key, sidecarBytes);
  return { structureUpdate, encryptedSidecar };
}

/**
 * Decrypt a content-encrypted update, restoring the original Y.js update.
 *
 * Returns a V2 update by default. Pass `outputVersion: 1` to get a V1 update.
 */
export async function decryptUpdateContent(
  key: CryptoKey,
  encrypted: ContentEncryptedUpdate,
  outputVersion: 1 | 2 = 2,
): Promise<Uint8Array> {
  const sidecarBytes = await decryptUpdate(key, encrypted.encryptedSidecar);
  const sidecar = decodeSidecar(sidecarBytes);
  return restoreContent(encrypted.structureUpdate, sidecar, outputVersion);
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
  outputVersion: 1 | 2 = 2,
): Promise<Uint8Array> {
  const decryptedBytes = await Promise.all(encryptedSidecars.map((sc) => decryptUpdate(key, sc)));
  const sidecars = decryptedBytes.map(decodeSidecar);
  return restoreContent(structureUpdate, mergeSidecars(sidecars), outputVersion);
}

/**
 * Encrypt a V2 update into a content-encrypted payload suitable for storage
 * or milestone creation. Returns the binary-encoded payload.
 */
export async function encryptToContentPayload(
  key: CryptoKey,
  v2Update: Uint8Array,
): Promise<Uint8Array> {
  const { structureUpdate, encryptedSidecar } = await encryptUpdateContent(key, v2Update, 2);
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

  const decryptedBytes = await Promise.all(sidecars.map((sc) => decryptUpdate(key, sc)));

  const deduped = new Map<string, ContentEntry>();
  const dictionary: MetadataDictionary = new Map();
  for (const bytes of decryptedBytes) {
    const sidecar = decodeSidecar(bytes);
    for (const entry of sidecar.entries) {
      deduped.set(`${entry.clientId}:${entry.clock}`, entry);
    }
    for (const [token, original] of sidecar.dictionary) {
      dictionary.set(token, original);
    }
  }

  const merged = [...deduped.values()];
  const compactedBytes = encodeSidecar({ entries: merged, dictionary });
  const encrypted = await encryptUpdate(key, compactedBytes);
  const index = buildSidecarIndex(merged);

  return { encrypted, index, hash: hashSidecar(encrypted) };
}

// ── Sidecar garbage collection ─────────────────────────────────────────────

type AliveRange = { clock: number; length: number };

/**
 * Scan a V2 structure update and collect the (clientId, clock, length) ranges
 * for every item that carries encryptable content. GC structs, Skip structs,
 * ContentDeleted, and ContentType are excluded — they have no sidecar entry.
 */
function collectAliveContentRanges(structureUpdate: Uint8Array): Map<number, AliveRange[]> {
  const rawDecoder = decoding.createDecoder(structureUpdate);
  const decoder = new Y.UpdateDecoderV2(rawDecoder);
  const alive = new Map<number, AliveRange[]>();

  const numClients = decoding.readVarUint(decoder.restDecoder);

  for (let c = 0; c < numClients; c++) {
    const numStructs = decoding.readVarUint(decoder.restDecoder);
    const clientId = decoder.readClient();
    let clock = decoding.readVarUint(decoder.restDecoder);

    for (let s = 0; s < numStructs; s++) {
      const info = decoder.readInfo();
      const contentRef = info & BITS5;

      if (contentRef === 0) {
        clock += decoder.readLen();
        continue;
      }
      if (contentRef === 10) {
        clock += decoding.readVarUint(decoder.restDecoder);
        continue;
      }

      skipItemMetadata(decoder, info);

      if (hasEncryptableContent(contentRef)) {
        const itemLength = skipContent(decoder, contentRef);
        let ranges = alive.get(clientId);
        if (!ranges) {
          ranges = [];
          alive.set(clientId, ranges);
        }
        ranges.push({ clock, length: itemLength });
        clock += itemLength;
      } else if (contentRef === CONTENT_TYPE) {
        const typeRef = decoder.readTypeRef();
        if (typeRef === 3 || typeRef === 5) decoder.readKey();
        clock += 1;
      } else {
        clock += decoder.readLen();
      }
    }
  }

  return alive;
}

/**
 * Remove sidecar entries whose entire clock range has been garbage-collected
 * in the structure update. An entry is kept if ANY of its clock range
 * `[clock, clock + itemLength)` overlaps with an alive encryptable item.
 *
 * The dictionary is preserved as-is — tokens may still be referenced by
 * metadata strings in the structure update.
 */
export function gcSidecar(
  structureUpdate: Uint8Array,
  sidecar: Sidecar,
  structureVersion: 1 | 2 = 2,
): Sidecar {
  const alive =
    structureVersion === 1
      ? collectAliveContentRangesV1(structureUpdate)
      : collectAliveContentRanges(structureUpdate);

  const entries = sidecar.entries.filter((entry) => {
    const ranges = alive.get(entry.clientId);
    if (!ranges) return false;

    const entryEnd = entry.clock + entry.itemLength;
    for (const range of ranges) {
      const rangeEnd = range.clock + range.length;
      if (range.clock < entryEnd && rangeEnd > entry.clock) {
        return true;
      }
    }
    return false;
  });

  return { entries, dictionary: sidecar.dictionary };
}
