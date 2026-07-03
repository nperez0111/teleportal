import { describe, it } from "bun:test";
import * as Y from "yjs";
import { createContentIdsFromUpdate } from "../src/lib/attribution/extract";
import {
  encodeContentIds,
  encodeContentMap,
  decodeContentMap,
  decodeContentIds,
} from "../src/lib/attribution/encoding";
import {
  createContentMapFromContentIds,
  createContentAttribute,
  recordToAttrs,
  mergeContentMaps,
  type ContentMap,
  excludeContentMap,
  createContentIdsFromContentMap,
  IdMap,
} from "../src/lib/attribution/content-map";
import { getActivity, resolveItemAttribution } from "../src/lib/attribution/queries";
import { type ContentIds, createContentIds, IdSet } from "../src/lib/attribution/content-ids";
import {
  collectRangeIds,
  resolveRangeAttribution,
  resolveDeletedRangeAttribution,
} from "../src/protocols/attribution/resolve";
import {
  encodeContentEncryptedPayload,
  decodeContentEncryptedPayload,
} from "../src/lib/protocol/encryption/encoding";
import type { VersionedUpdate, Update, UpdateV2 } from "teleportal";
import type { EncryptedUpdatePayload } from "../src/lib/protocol/encryption/encoding";
import type { EncodedContentMap } from "../src/storage/types";
import { bench, formatBytes, formatDuration } from "./helpers";

// ─── Scenario Builders ──────────────────────────────────────────────────────

const USERS = ["alice", "bob", "carol", "dave", "eve"];

/**
 * Simulate a collaborative editing session. Each user types sequentially into
 * the same document. Returns the final doc, the merged ContentMap, and an
 * array of individual encoded maps (for compaction benchmarks).
 */
function buildCollaborativeDoc(opts: {
  users: string[];
  editsPerUser: number;
  docSizeChars?: number;
}): {
  doc: Y.Doc;
  map: ContentMap;
  encodedMaps: EncodedContentMap[];
  totalEdits: number;
} {
  const seed = new Y.Doc();
  const initialSize = opts.docSizeChars ?? 0;
  if (initialSize > 0) {
    const chunk = "x".repeat(Math.min(initialSize, 1000));
    const text = seed.getText("t");
    for (let i = 0; i < initialSize; i += chunk.length) {
      text.insert(i, chunk.substring(0, Math.min(chunk.length, initialSize - i)));
    }
  }

  const maps: ContentMap[] = [];
  const encodedMaps: EncodedContentMap[] = [];
  let totalEdits = 0;

  for (let round = 0; round < opts.editsPerUser; round++) {
    for (const userId of opts.users) {
      const userDoc = new Y.Doc();
      Y.applyUpdateV2(userDoc, Y.encodeStateAsUpdateV2(seed));

      let captured!: Uint8Array;
      userDoc.on("updateV2", (u: Uint8Array) => (captured = u));

      const text = userDoc.getText("t");
      const pos = Math.floor(Math.random() * Math.max(1, text.length));
      const action = Math.random();
      if (action < 0.6 || text.length < 10) {
        // Insert
        const words = ["hello ", "world ", "foo ", "bar ", "test ", "edit "];
        text.insert(pos, words[round % words.length]);
      } else if (action < 0.8) {
        // Delete
        const delLen = Math.min(3, text.length - pos);
        if (delLen > 0) text.delete(pos, delLen);
      } else {
        // Replace (delete + insert)
        const delLen = Math.min(2, text.length - pos);
        if (delLen > 0) text.delete(pos, delLen);
        text.insert(pos, "replaced ");
      }

      if (captured) {
        Y.applyUpdateV2(seed, captured);

        const ids = createContentIdsFromUpdate({ version: 2, data: captured as UpdateV2 });
        const ts = 1700000000000 + totalEdits * 500;
        const contentMap = createContentMapFromContentIds(
          ids,
          [createContentAttribute("insert", userId), createContentAttribute("insertAt", ts)],
          [createContentAttribute("delete", userId), createContentAttribute("deleteAt", ts)],
        );
        maps.push(contentMap);
        encodedMaps.push(encodeContentMap(contentMap));
        totalEdits++;
      }
    }
  }

  const merged = mergeContentMaps(maps);
  return { doc: seed, map: merged, encodedMaps, totalEdits };
}

type Scenario = ReturnType<typeof buildCollaborativeDoc>;

/**
 * Pre-build scenarios at various scales so each benchmark group can pick what
 * it needs without re-generating.
 */
function buildScenarios() {
  const small = buildCollaborativeDoc({ users: USERS.slice(0, 2), editsPerUser: 10 });
  const medium = buildCollaborativeDoc({ users: USERS.slice(0, 3), editsPerUser: 50 });
  const large = buildCollaborativeDoc({
    users: USERS,
    editsPerUser: 100,
    docSizeChars: 5_000,
  });
  return { small, medium, large };
}

function scenarioInfo(s: Scenario, label: string) {
  const encoded = encodeContentMap(s.map);
  const docLen = s.doc.getText("t").length;
  console.log(
    `    [${label}] edits=${s.totalEdits}, doc=${docLen} chars, ` +
      `contentMap=${formatBytes(encoded.byteLength)}, ` +
      `clients=${s.map.inserts.clients.size}`,
  );
}

// ─── Benchmarks ─────────────────────────────────────────────────────────────

describe("Attribution Read-Path Benchmarks", () => {
  const scenarios = buildScenarios();

  // ──────────────────────────────────────────────────────────────────────
  // 1. resolveItemAttribution — point lookup (binary search)
  // ──────────────────────────────────────────────────────────────────────
  describe("resolveItemAttribution (point lookup)", () => {
    for (const [label, scenario] of Object.entries(scenarios)) {
      it(`${label} scenario — single point lookup`, async () => {
        scenarioInfo(scenario, label);
        const { map } = scenario;

        // Pick a client/clock that exists
        const [clientId, ranges] = [...map.inserts.clients.entries()][0];
        const clock = ranges.getIds()[0].clock;

        await bench(
          `resolveItemAttribution [${label}]`,
          () => {
            resolveItemAttribution(map, clientId, clock);
          },
          { iterations: 2000 },
        );
      });

      it(`${label} scenario — 100 random point lookups`, async () => {
        const { map } = scenario;
        const entries = [...map.inserts.clients.entries()];
        const lookups = Array.from({ length: 100 }, (_, i) => {
          const [client, ranges] = entries[i % entries.length];
          const ids = ranges.getIds();
          const range = ids[i % ids.length];
          return { client, clock: range.clock + Math.floor(range.len / 2) };
        });

        await bench(
          `resolveItemAttribution ×100 [${label}]`,
          () => {
            for (const { client, clock } of lookups) {
              resolveItemAttribution(map, client, clock);
            }
          },
          { iterations: 500 },
        );
      });
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  // 2. IdMap.has — binary search vs linear (many clients)
  // ──────────────────────────────────────────────────────────────────────
  describe("IdMap.has — lookup across many clients", () => {
    it("100 clients, 1000 lookups", async () => {
      const idMap = new IdMap();
      for (let c = 0; c < 100; c++) {
        for (let i = 0; i < 50; i++) {
          idMap.add(c, i * 100, 10, [createContentAttribute("insert", `u${c}`)]);
        }
      }
      console.log(`    100 clients × 50 ranges each = 5000 ranges total`);

      const lookups = Array.from({ length: 1000 }, (_, i) => ({
        client: i % 100,
        clock: (i % 50) * 100 + 5,
      }));

      await bench(
        "IdMap.has ×1000 (100 clients)",
        () => {
          for (const { client, clock } of lookups) {
            idMap.has(client, clock);
          }
        },
        { iterations: 500 },
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // 3. collectRangeIds — search marker benefit at various offsets
  // ──────────────────────────────────────────────────────────────────────
  describe("collectRangeIds (search marker optimization)", () => {
    for (const docSize of [1_000, 10_000, 50_000]) {
      it(`doc ${docSize / 1000}K chars — range at start`, async () => {
        const doc = new Y.Doc();
        doc.getText("t").insert(0, "A".repeat(docSize));
        // Warm up search markers
        doc.getText("t").toString();

        await bench(
          `collectRangeIds at start [${docSize / 1000}K]`,
          () => {
            collectRangeIds(doc.getText("t"), 0, 50);
          },
          { iterations: 2000 },
        );
      });

      it(`doc ${docSize / 1000}K chars — range at middle`, async () => {
        const doc = new Y.Doc();
        doc.getText("t").insert(0, "A".repeat(docSize));
        doc.getText("t").toString();

        const mid = Math.floor(docSize / 2);
        await bench(
          `collectRangeIds at middle [${docSize / 1000}K]`,
          () => {
            collectRangeIds(doc.getText("t"), mid, 50);
          },
          { iterations: 2000 },
        );
      });

      it(`doc ${docSize / 1000}K chars — range near end`, async () => {
        const doc = new Y.Doc();
        doc.getText("t").insert(0, "A".repeat(docSize));
        doc.getText("t").toString();

        const near_end = docSize - 100;
        await bench(
          `collectRangeIds near end [${docSize / 1000}K]`,
          () => {
            collectRangeIds(doc.getText("t"), near_end, 50);
          },
          { iterations: 2000 },
        );
      });
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  // 4. resolveRangeAttribution — end-to-end read (markers + binary search)
  // ──────────────────────────────────────────────────────────────────────
  describe("resolveRangeAttribution (end-to-end read)", () => {
    for (const [label, scenario] of Object.entries(scenarios)) {
      it(`${label} scenario — 50-char range at middle`, async () => {
        scenarioInfo(scenario, label);
        const { doc, map } = scenario;
        const text = doc.getText("t");
        const mid = Math.floor(text.length / 2);
        const rangeLen = Math.min(50, text.length - mid);

        // Warm markers
        text.toString();

        await bench(
          `resolveRangeAttribution [${label}]`,
          () => {
            resolveRangeAttribution(text, mid, rangeLen, map);
          },
          { iterations: 1000 },
        );
      });

      it(`${label} scenario — full document range`, async () => {
        const { doc, map } = scenario;
        const text = doc.getText("t");
        text.toString();

        await bench(
          `resolveRangeAttribution full doc [${label}]`,
          () => {
            resolveRangeAttribution(text, 0, text.length, map);
          },
          { iterations: 500 },
        );
      });
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  // 5. getActivity — timeline query on large maps
  // ──────────────────────────────────────────────────────────────────────
  describe("getActivity (timeline query)", () => {
    for (const [label, scenario] of Object.entries(scenarios)) {
      it(`${label} scenario — unfiltered`, async () => {
        scenarioInfo(scenario, label);
        const { map } = scenario;

        await bench(
          `getActivity [${label}]`,
          () => {
            getActivity(map);
          },
          { iterations: 500 },
        );
      });

      it(`${label} scenario — filtered by userId`, async () => {
        const { map } = scenario;

        await bench(
          `getActivity userId filter [${label}]`,
          () => {
            getActivity(map, { userId: "alice" });
          },
          { iterations: 500 },
        );
      });

      it(`${label} scenario — filtered by time range`, async () => {
        const { map } = scenario;

        await bench(
          `getActivity time filter [${label}]`,
          () => {
            getActivity(map, {
              from: 1700000010000,
              to: 1700000030000,
            });
          },
          { iterations: 500 },
        );
      });
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  // 6. Storage compaction — merge N maps vs read pre-compacted
  // ──────────────────────────────────────────────────────────────────────
  describe("storage compaction benefit", () => {
    for (const [label, scenario] of Object.entries(scenarios)) {
      it(`${label} — merge-on-read (${scenario.encodedMaps.length} maps)`, async () => {
        const { encodedMaps } = scenario;
        console.log(
          `    maps to merge: ${encodedMaps.length}, ` +
            `total bytes: ${formatBytes(encodedMaps.reduce((s, m) => s + m.byteLength, 0))}`,
        );

        await bench(
          `merge-on-read [${label}]`,
          () => {
            mergeContentMaps(encodedMaps.map((m) => decodeContentMap(m)));
          },
          { iterations: 200 },
        );
      });

      it(`${label} — pre-compacted single decode`, async () => {
        const { map } = scenario;
        const compacted = encodeContentMap(map);
        console.log(`    compacted size: ${formatBytes(compacted.byteLength)}`);

        await bench(
          `pre-compacted decode [${label}]`,
          () => {
            decodeContentMap(compacted);
          },
          { iterations: 500 },
        );
      });
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  // 7. Incremental sync — diff vs full fetch
  // ──────────────────────────────────────────────────────────────────────
  describe("incremental sync overhead", () => {
    for (const [label, scenario] of Object.entries(scenarios)) {
      it(`${label} — full encode+decode round-trip`, async () => {
        const { map } = scenario;
        const encoded = encodeContentMap(map);
        console.log(`    full contentMap: ${formatBytes(encoded.byteLength)}`);

        await bench(
          `full sync round-trip [${label}]`,
          () => {
            const enc = encodeContentMap(map);
            decodeContentMap(enc);
          },
          { iterations: 500 },
        );
      });

      it(`${label} — incremental (client has 80% of data)`, async () => {
        const { encodedMaps, map } = scenario;

        // Client has first 80% of edits
        const knownCount = Math.floor(encodedMaps.length * 0.8);
        const knownMaps = encodedMaps.slice(0, knownCount);
        const knownMap = mergeContentMaps(knownMaps.map((m) => decodeContentMap(m)));
        const knownIds = createContentIdsFromContentMap(knownMap);
        const encodedKnownIds = encodeContentIds(knownIds);

        const fullEncoded = encodeContentMap(map);
        console.log(
          `    client knows ${knownCount}/${encodedMaps.length} edits, ` +
            `knownIds: ${formatBytes(encodedKnownIds.byteLength)}, ` +
            `full map: ${formatBytes(fullEncoded.byteLength)}`,
        );

        await bench(
          `incremental sync [${label}]`,
          () => {
            // Server side: decode full, decode known, exclude, encode diff
            const fullMap = decodeContentMap(fullEncoded);
            const decoded = decodeContentIds(encodedKnownIds);
            const diff = excludeContentMap(fullMap, decoded);
            encodeContentMap(diff);
          },
          { iterations: 300 },
        );
      });
    }
  });
});

// ─── Write-Path Benchmarks (existing, preserved) ───────────────────────────

describe("Attribution Write-Path Benchmarks", () => {
  function wrapUpdate(rawV2: Uint8Array): VersionedUpdate {
    const payload = encodeContentEncryptedPayload({
      structureUpdate: rawV2,
      encryptedSidecars: [],
    });
    return { version: 2, data: payload as Update } as VersionedUpdate;
  }

  function generateDiff(baseDoc: Y.Doc, editFn: (text: Y.Text) => void): Uint8Array {
    const beforeState = Y.encodeStateVector(baseDoc);
    editFn(baseDoc.getText("content"));
    return Y.encodeStateAsUpdateV2(baseDoc, beforeState);
  }

  function createLargeDoc(charCount: number): Y.Doc {
    const doc = new Y.Doc();
    const text = doc.getText("content");
    const chunk = "x".repeat(Math.min(charCount, 1000));
    for (let i = 0; i < charCount; i += chunk.length) {
      text.insert(i, chunk.substring(0, Math.min(chunk.length, charCount - i)));
    }
    return doc;
  }

  describe("createContentIdsFromUpdate by edit size", () => {
    const sentence = "The quick brown fox jumps over the lazy dog, again and again. ";
    const paragraph =
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit. ";

    it("single char insert on 3K doc", async () => {
      const doc = createLargeDoc(3_000);
      const diff = generateDiff(doc, (text) => text.insert(1500, "x"));
      const update = { version: 2, data: diff } as VersionedUpdate;
      console.log(`    diff size: ${formatBytes(diff.byteLength)}`);

      await bench(
        "createContentIdsFromUpdate (1 char)",
        () => {
          createContentIdsFromUpdate(update);
        },
        { iterations: 500 },
      );
    });

    it("sentence insert (~60 chars) on 3K doc", async () => {
      const doc = createLargeDoc(3_000);
      const diff = generateDiff(doc, (text) => text.insert(1500, sentence));
      const update = { version: 2, data: diff } as VersionedUpdate;

      await bench(
        "createContentIdsFromUpdate (sentence)",
        () => {
          createContentIdsFromUpdate(update);
        },
        { iterations: 200 },
      );
    });

    it("paragraph insert (~300 chars) on 3K doc", async () => {
      const doc = createLargeDoc(3_000);
      const diff = generateDiff(doc, (text) => text.insert(1500, paragraph));
      const update = { version: 2, data: diff } as VersionedUpdate;

      await bench(
        "createContentIdsFromUpdate (paragraph)",
        () => {
          createContentIdsFromUpdate(update);
        },
        { iterations: 200 },
      );
    });
  });

  describe("createContentIdsFromUpdate vs doc size", () => {
    for (const charCount of [1_000, 5_000, 20_000, 50_000]) {
      it(`single char insert on ${charCount / 1000}K char doc`, async () => {
        const doc = createLargeDoc(charCount);
        const diff = generateDiff(doc, (text) => text.insert(Math.floor(charCount / 2), "z"));
        const update = { version: 2, data: diff } as VersionedUpdate;

        await bench(
          `createContentIdsFromUpdate (${charCount / 1000}K doc)`,
          () => {
            createContentIdsFromUpdate(update);
          },
          { iterations: 500 },
        );
      });
    }
  });

  describe("full computeAttribution pipeline", () => {
    it("single char edit, no custom attrs", async () => {
      const doc = createLargeDoc(3_000);
      const diff = generateDiff(doc, (text) => text.insert(1500, "x"));
      const wrapped = wrapUpdate(diff);

      await bench(
        "full pipeline (1 char, no custom)",
        () => {
          const payload = decodeContentEncryptedPayload(wrapped.data as EncryptedUpdatePayload);
          const attrUpdate = {
            version: 2,
            data: payload.structureUpdate,
          } as unknown as VersionedUpdate;
          const contentIds = createContentIdsFromUpdate(attrUpdate);
          const now = Date.now();
          encodeContentMap(
            createContentMapFromContentIds(contentIds, [
              createContentAttribute("insert", "user-123"),
              createContentAttribute("insertAt", now),
            ]),
          );
        },
        { iterations: 500 },
      );
    });

    it("paragraph edit, with custom attrs", async () => {
      const paragraph =
        "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt. ";
      const doc = createLargeDoc(3_000);
      const diff = generateDiff(doc, (text) => text.insert(1500, paragraph));
      const wrapped = wrapUpdate(diff);

      await bench(
        "full pipeline (paragraph, custom attrs)",
        () => {
          const payload = decodeContentEncryptedPayload(wrapped.data as EncryptedUpdatePayload);
          const attrUpdate = {
            version: 2,
            data: payload.structureUpdate,
          } as unknown as VersionedUpdate;
          const contentIds = createContentIdsFromUpdate(attrUpdate);
          const now = Date.now();
          const insertAttrs = [
            createContentAttribute("insert", "user-123"),
            createContentAttribute("insertAt", now),
            ...recordToAttrs({ source: "editor", version: 1 }),
          ];
          const deleteAttrs = [
            createContentAttribute("delete", "user-123"),
            createContentAttribute("deleteAt", now),
            ...recordToAttrs({ source: "editor", version: 1 }),
          ];
          encodeContentMap(createContentMapFromContentIds(contentIds, insertAttrs, deleteAttrs));
        },
        { iterations: 200 },
      );
    });
  });

  describe("burst of updates", () => {
    it("50 sequential single-char edits through full pipeline", async () => {
      const doc = createLargeDoc(3_000);
      const wrappedUpdates: VersionedUpdate[] = [];
      for (let i = 0; i < 50; i++) {
        const diff = generateDiff(doc, (text) =>
          text.insert(Math.min(i, text.length), String.fromCharCode(97 + (i % 26))),
        );
        wrappedUpdates.push(wrapUpdate(diff));
      }

      await bench(
        "burst: 50 single-char edits full pipeline",
        () => {
          for (const wrapped of wrappedUpdates) {
            const payload = decodeContentEncryptedPayload(wrapped.data as EncryptedUpdatePayload);
            const attrUpdate = {
              version: 2,
              data: payload.structureUpdate,
            } as unknown as VersionedUpdate;
            const contentIds = createContentIdsFromUpdate(attrUpdate);
            const now = Date.now();
            encodeContentMap(
              createContentMapFromContentIds(contentIds, [
                createContentAttribute("insert", "user-123"),
                createContentAttribute("insertAt", now),
              ]),
            );
          }
        },
        { iterations: 100 },
      );
    });
  });
});
