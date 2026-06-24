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

// ── Metadata string hashing ────────────────────────────────────────────────

function opaqueToken(str: string): string {
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
      const data = allData.slice(dataOffset, dataOffset + dataLen);
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
      const strings: string[] = [];
      for (let i = 0; i < count; i++) strings.push(decoding.readVarString(dec));
      const tail = strings.slice(offset);
      encoder.writeLen(tail.length);
      for (const s of tail) encoder.writeString(s);
      break;
    }
    case CONTENT_ANY: {
      const count = decoding.readVarUint(dec);
      const anys: unknown[] = [];
      for (let i = 0; i < count; i++) anys.push(decoding.readAny(dec));
      const tail = anys.slice(offset);
      encoder.writeLen(tail.length);
      for (const a of tail) encoder.writeAny(a);
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

/**
 * Parse a Y.js update and separate CRDT metadata from content.
 *
 * Accepts V1 or V2 input (via `version` parameter, default V2). Always
 * outputs a V2 structure update with placeholder content and a sidecar
 * containing the original content entries.
 */
export function stripContent(update: Uint8Array, version: 1 | 2 = 2): StrippedUpdate {
  const rawDecoder = decoding.createDecoder(update);
  const decoder: UpdateDecoder =
    version === 2 ? new Y.UpdateDecoderV2(rawDecoder) : new Y.UpdateDecoderV1(rawDecoder);
  const encoder = new Y.UpdateEncoderV2();

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
        const { data, itemLength } = readContentToSidecar(decoder, contentRef);
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
 * Takes a V2 structure update (with placeholder content) and the original
 * content entries, and produces the cleartext update.
 *
 * Output version defaults to V2. Pass `outputVersion: 1` for V1 output.
 */
export function restoreContent(
  structureUpdate: Uint8Array,
  sidecar: Sidecar,
  outputVersion: 1 | 2 = 2,
): Uint8Array {
  const entryMap = buildSidecarMap(sidecar.entries);
  const rangeIndex = buildSidecarRangeIndex(sidecar.entries);
  const rawDecoder = decoding.createDecoder(structureUpdate);
  const decoder = new Y.UpdateDecoderV2(rawDecoder);
  const encoder: UpdateEncoder =
    outputVersion === 2 ? new Y.UpdateEncoderV2() : new Y.UpdateEncoderV1();
  const reverseTransform = (token: string) => sidecar.dictionary.get(token) ?? token;

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
        let entry = entryMap.get(sidecarKey(clientId, clock));
        let offset = 0;
        if (!entry) {
          // Y.diffUpdateV2 slices a multi-clock content item when the peer
          // holds a prefix, so the struct's clock can fall inside an entry's
          // range rather than on its start. Locate the containing entry and
          // restore the matching tail.
          const containing = findContainingEntry(rangeIndex.get(clientId), clock);
          if (containing) {
            entry = containing;
            offset = clock - containing.clock;
          }
        }
        // An encryptable item's placeholder content is NOT length-prefixed
        // (e.g. a string, embed JSON, or binary buffer), so we cannot fall
        // back to reading a length here. A missing entry means the sidecar
        // set is incomplete for this structure update — fail loudly rather
        // than silently desyncing the decoder and corrupting the rest of
        // the update.
        if (!entry) {
          throw new Error(
            `restoreContent: missing sidecar entry for encryptable content ` +
              `(clientId=${clientId}, clock=${clock}, contentRef=${contentRef})`,
          );
        }
        // Skip placeholder content in the structure update
        const itemLength = skipContent(decoder, contentRef);
        // Write original content (sliced to match the placeholder) from sidecar
        writeSlicedContentFromSidecar(encoder, contentRef, entry.data, offset);
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
  const { update: structureUpdate, sidecar } = stripContent(update, version);
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
  const sidecars: Sidecar[] = [];
  for (const encrypted of encryptedSidecars) {
    const bytes = await decryptUpdate(key, encrypted);
    sidecars.push(decodeSidecar(bytes));
  }
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

  const decoded: Sidecar[] = [];
  for (const sidecar of sidecars) {
    const bytes = await decryptUpdate(key, sidecar);
    decoded.push(decodeSidecar(bytes));
  }
  const combined = mergeSidecars(decoded);

  const deduped = new Map<string, ContentEntry>();
  for (const entry of combined.entries) {
    deduped.set(`${entry.clientId}:${entry.clock}`, entry);
  }

  const merged = [...deduped.values()];
  const compactedBytes = encodeSidecar({ entries: merged, dictionary: combined.dictionary });
  const encrypted = await encryptUpdate(key, compactedBytes);
  const index = buildSidecarIndex(merged);

  return { encrypted, index, hash: hashSidecar(encrypted) };
}
