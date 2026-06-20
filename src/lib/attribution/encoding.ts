/**
 * Binary encoding/decoding for ContentIds and ContentMap.
 *
 * Uses delta-encoded format matching Y.js v14's IdSetEncoderV2/IdSetDecoderV2.
 * When teleportal upgrades to v14, these encoded blobs are wire-compatible with
 * Y.encodeContentMap / Y.decodeContentMap.
 *
 * Format (IdSet):
 *   VarUint: numClients
 *   For each client (sorted by clientID descending):
 *     VarUint: clientID
 *     VarUint: numberOfRanges
 *     For each range (delta-encoded):
 *       VarUint: clock delta from previous
 *       VarUint: length - 1
 *
 * Format (IdMap / ContentMap):
 *   VarUint: numClients
 *   For each client (sorted by clientID ascending):
 *     VarUint: clientID delta from previous (first client is absolute)
 *     VarUint: numberOfRanges
 *     For each range (delta-encoded clock/len as IdSet, plus):
 *     VarUint: numberOfAttributes
 *     For each attribute:
 *       VarUint: attrIndex (into deduplication table)
 *       If new attr (index >= table size):
 *         VarUint: nameIndex (into name dedup table)
 *         If new name (index >= table size):
 *           VarString: name
 *         Any: value
 */

import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { type ContentIds, IdRange, IdRanges, IdSet } from "./content-ids";
import {
  AttrRange,
  AttrRanges,
  ContentAttribute,
  type ContentMap,
  IdMap,
  createContentMap,
} from "./content-map";

// --- IdSet encoding ---

function writeIdSet(encoder: encoding.Encoder, idSet: IdSet) {
  const clients = [...idSet.clients.entries()].sort(([a], [b]) => b - a);
  encoding.writeVarUint(encoder, clients.length);

  for (const [client, ranges] of clients) {
    encoding.writeVarUint(encoder, client);
    const ids = ranges.getIds();
    encoding.writeVarUint(encoder, ids.length);

    let currVal = 0;
    for (const range of ids) {
      encoding.writeVarUint(encoder, range.clock - currVal);
      currVal = range.clock;
      encoding.writeVarUint(encoder, range.len - 1);
      currVal += range.len;
    }
  }
}

function readIdSet(decoder: decoding.Decoder): IdSet {
  const idSet = new IdSet();
  const numClients = decoding.readVarUint(decoder);

  for (let i = 0; i < numClients; i++) {
    const client = decoding.readVarUint(decoder);
    const numRanges = decoding.readVarUint(decoder);

    if (numRanges > 0) {
      const ranges: IdRange[] = [];
      let currVal = 0;
      for (let j = 0; j < numRanges; j++) {
        currVal += decoding.readVarUint(decoder);
        const clock = currVal;
        const len = decoding.readVarUint(decoder) + 1;
        currVal += len;
        ranges.push(new IdRange(clock, len));
      }
      idSet.clients.set(client, new IdRanges(ranges));
    }
  }

  return idSet;
}

export type EncodedContentIds = Uint8Array & { _tag: "content-ids" };

const EMPTY_ENCODED_CONTENT_IDS = new Uint8Array([0, 0]) as EncodedContentIds;

export function getEmptyEncodedContentIds(): EncodedContentIds {
  return EMPTY_ENCODED_CONTENT_IDS;
}

export function encodeContentIds(contentIds: ContentIds): EncodedContentIds {
  const encoder = encoding.createEncoder();
  writeIdSet(encoder, contentIds.inserts);
  writeIdSet(encoder, contentIds.deletes);
  return encoding.toUint8Array(encoder) as EncodedContentIds;
}

export function decodeContentIds(buf: EncodedContentIds): ContentIds {
  const decoder = decoding.createDecoder(buf);
  return {
    inserts: readIdSet(decoder),
    deletes: readIdSet(decoder),
  };
}

// --- IdMap / ContentMap encoding ---

function writeIdMap(encoder: encoding.Encoder, idMap: IdMap) {
  const visitedAttrNames: string[] = [];
  const nameIndex = new Map<string, number>();
  const visitedAttrs: ContentAttribute[] = [];
  const attrIndex = new Map<string, number>();

  const clients = [...idMap.clients.entries()].sort(([a], [b]) => a - b);
  encoding.writeVarUint(encoder, clients.length);

  let lastClient = 0;
  for (const [client, ranges] of clients) {
    encoding.writeVarUint(encoder, client - lastClient);
    lastClient = client;
    const ids = ranges.getIds();
    encoding.writeVarUint(encoder, ids.length);

    let currVal = 0;
    for (const range of ids) {
      encoding.writeVarUint(encoder, range.clock - currVal);
      currVal = range.clock;
      encoding.writeVarUint(encoder, range.len - 1);
      currVal += range.len;

      encoding.writeVarUint(encoder, range.attrs.length);
      for (const attr of range.attrs) {
        const attrKey = `${attr.name}:${JSON.stringify(attr.val)}`;
        let idx = attrIndex.get(attrKey);
        if (idx === undefined) {
          idx = visitedAttrs.length;
          visitedAttrs.push(attr);
          attrIndex.set(attrKey, idx);
          encoding.writeVarUint(encoder, idx);

          // Write attribute name (deduplicated)
          let nIdx = nameIndex.get(attr.name);
          if (nIdx === undefined) {
            nIdx = visitedAttrNames.length;
            visitedAttrNames.push(attr.name);
            nameIndex.set(attr.name, nIdx);
            encoding.writeVarUint(encoder, nIdx);
            encoding.writeVarString(encoder, attr.name);
          } else {
            encoding.writeVarUint(encoder, nIdx);
          }

          encoding.writeAny(encoder, attr.val as encoding.AnyEncodable);
        } else {
          encoding.writeVarUint(encoder, idx);
        }
      }
    }
  }
}

function readIdMap(decoder: decoding.Decoder): IdMap {
  const idMap = new IdMap();
  const visitedAttrNames: string[] = [];
  const visitedAttrs: ContentAttribute[] = [];

  const numClients = decoding.readVarUint(decoder);

  let lastClient = 0;
  for (let i = 0; i < numClients; i++) {
    const client = lastClient + decoding.readVarUint(decoder);
    lastClient = client;
    const numRanges = decoding.readVarUint(decoder);
    const ranges: AttrRange[] = [];

    let currVal = 0;
    for (let j = 0; j < numRanges; j++) {
      currVal += decoding.readVarUint(decoder);
      const clock = currVal;
      const len = decoding.readVarUint(decoder) + 1;
      currVal += len;

      const numAttrs = decoding.readVarUint(decoder);
      const attrs: ContentAttribute[] = [];
      for (let k = 0; k < numAttrs; k++) {
        const attrId = decoding.readVarUint(decoder);
        if (attrId < visitedAttrs.length) {
          attrs.push(visitedAttrs[attrId]);
        } else {
          const nameId = decoding.readVarUint(decoder);
          let name: string;
          if (nameId < visitedAttrNames.length) {
            name = visitedAttrNames[nameId];
          } else {
            name = decoding.readVarString(decoder);
            visitedAttrNames.push(name);
          }
          const val = decoding.readAny(decoder);
          const attr = new ContentAttribute(name, val);
          visitedAttrs.push(attr);
          attrs.push(attr);
        }
      }

      ranges.push(new AttrRange(clock, len, attrs));
    }

    if (ranges.length > 0) {
      idMap.clients.set(client, new AttrRanges(ranges));
    }
  }

  return idMap;
}

import type { EncodedContentMap } from "../../storage/types";

export function encodeContentMap(contentMap: ContentMap): EncodedContentMap {
  const encoder = encoding.createEncoder();
  writeIdMap(encoder, contentMap.inserts);
  writeIdMap(encoder, contentMap.deletes);
  return encoding.toUint8Array(encoder) as EncodedContentMap;
}

export function decodeContentMap(buf: EncodedContentMap): ContentMap {
  const decoder = decoding.createDecoder(buf);
  return createContentMap(readIdMap(decoder), readIdMap(decoder));
}
