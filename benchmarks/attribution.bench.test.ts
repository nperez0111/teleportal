import { describe, it } from "bun:test";
import * as Y from "yjs";
import { createContentIdsFromUpdate } from "../src/lib/attribution/extract";
import { encodeContentMap, decodeContentMap } from "../src/lib/attribution/encoding";
import { createContentMapFromContentIds } from "../src/lib/attribution/content-map";
import { createContentAttribute } from "../src/lib/attribution/content-map";
import { recordToAttrs } from "../src/lib/attribution/content-map";
import {
  encodeContentEncryptedPayload,
  decodeContentEncryptedPayload,
} from "../src/lib/protocol/encryption/encoding";
import type { VersionedUpdate, Update } from "teleportal";
import type { EncryptedUpdatePayload } from "../src/lib/protocol/encryption/encoding";
import { bench, createLargeDoc, formatBytes } from "./helpers";

/**
 * Wrap a raw V2 update into an encrypted payload format, simulating what
 * the server receives on the wire when content-encryption is enabled.
 */
function wrapUpdate(rawV2: Uint8Array): VersionedUpdate {
  const payload = encodeContentEncryptedPayload({
    structureUpdate: rawV2,
    encryptedSidecars: [],
  });
  return { version: 2, data: payload as Update } as VersionedUpdate;
}

/**
 * Generate a V2 diff for an incremental edit on a document.
 * Returns the diff (not the full state), which is what the server receives.
 */
function generateDiff(baseDoc: Y.Doc, editFn: (text: Y.Text) => void): Uint8Array {
  const beforeState = Y.encodeStateVector(baseDoc);
  editFn(baseDoc.getText("content"));
  return Y.encodeStateAsUpdateV2(baseDoc, beforeState);
}

/**
 * Build standard insert/delete attribution attributes.
 */
function createStandardAttrs() {
  const now = Date.now();
  const insertAttrs = [
    createContentAttribute("insert", "user-bench-123"),
    createContentAttribute("insertAt", now),
  ];
  const deleteAttrs = [
    createContentAttribute("delete", "user-bench-123"),
    createContentAttribute("deleteAt", now),
  ];
  return { insertAttrs, deleteAttrs };
}

describe("Attribution Benchmarks", () => {
  // ──────────────────────────────────────────────────────────────────────
  // 1. createContentIdsFromUpdate by edit size
  // ──────────────────────────────────────────────────────────────────────
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
      console.log(
        `    diff size: ${formatBytes(diff.byteLength)}, insert length: ${sentence.length} chars`,
      );

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
      console.log(
        `    diff size: ${formatBytes(diff.byteLength)}, insert length: ${paragraph.length} chars`,
      );

      await bench(
        "createContentIdsFromUpdate (paragraph)",
        () => {
          createContentIdsFromUpdate(update);
        },
        { iterations: 200 },
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // 2. createContentIdsFromUpdate as document grows
  // ──────────────────────────────────────────────────────────────────────
  describe("createContentIdsFromUpdate vs doc size", () => {
    for (const charCount of [1_000, 5_000, 20_000, 50_000]) {
      it(`single char insert on ${charCount / 1000}K char doc`, async () => {
        const doc = createLargeDoc(charCount);
        const diff = generateDiff(doc, (text) =>
          text.insert(Math.floor(charCount / 2), "z"),
        );
        const update = { version: 2, data: diff } as VersionedUpdate;
        console.log(
          `    doc: ${charCount / 1000}K chars, diff size: ${formatBytes(diff.byteLength)}`,
        );

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

  // ──────────────────────────────────────────────────────────────────────
  // 3. encodeContentMap / decodeContentMap round-trip
  // ──────────────────────────────────────────────────────────────────────
  describe("encodeContentMap / decodeContentMap round-trip", () => {
    for (const editCount of [1, 10, 50, 100]) {
      it(`${editCount} edit(s) worth of content IDs`, async () => {
        // Generate N incremental edits from separate docs (different client IDs)
        // so the content map has N distinct entries rather than one merged range
        const { insertAttrs, deleteAttrs } = createStandardAttrs();
        const allContentIds = [];

        for (let i = 0; i < editCount; i++) {
          const doc = createLargeDoc(3_000);
          const diff = generateDiff(doc, (text) =>
            text.insert(Math.min(i, text.length), String.fromCharCode(97 + (i % 26))),
          );
          const update = { version: 2, data: diff } as VersionedUpdate;
          allContentIds.push(createContentIdsFromUpdate(update));
        }

        // Merge all content IDs into a single ContentMap
        const contentMap = createContentMapFromContentIds(
          allContentIds[0],
          insertAttrs,
          deleteAttrs,
        );
        for (let i = 1; i < allContentIds.length; i++) {
          const partial = createContentMapFromContentIds(
            allContentIds[i],
            insertAttrs,
            deleteAttrs,
          );
          for (const [client, ranges] of partial.inserts.clients.entries()) {
            for (const range of ranges.getIds()) {
              contentMap.inserts.add(client, range.clock, range.len, range.attrs);
            }
          }
          for (const [client, ranges] of partial.deletes.clients.entries()) {
            for (const range of ranges.getIds()) {
              contentMap.deletes.add(client, range.clock, range.len, range.attrs);
            }
          }
        }

        const encoded = encodeContentMap(contentMap);
        console.log(
          `    edits: ${editCount}, encoded contentMap size: ${formatBytes(encoded.byteLength)}`,
        );

        await bench(
          `encode+decode contentMap (${editCount} edits)`,
          () => {
            const enc = encodeContentMap(contentMap);
            decodeContentMap(enc);
          },
          { iterations: editCount <= 10 ? 500 : 200 },
        );
      });
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  // 4. Full computeAttribution pipeline (end-to-end)
  // ──────────────────────────────────────────────────────────────────────
  describe("full computeAttribution pipeline", () => {
    const paragraph =
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit. ";

    it("single char edit, no custom attrs", async () => {
      const doc = createLargeDoc(3_000);
      const diff = generateDiff(doc, (text) => text.insert(1500, "x"));
      const wrapped = wrapUpdate(diff);
      console.log(
        `    wrapped update size: ${formatBytes((wrapped.data as Uint8Array).byteLength)}`,
      );

      await bench(
        "full pipeline (1 char, no custom)",
        () => {
          const payload = decodeContentEncryptedPayload(
            wrapped.data as EncryptedUpdatePayload,
          );
          const attrUpdate = {
            version: 2,
            data: payload.structureUpdate,
          } as unknown as VersionedUpdate;
          const contentIds = createContentIdsFromUpdate(attrUpdate);

          const now = Date.now();
          const insertAttrs = [
            createContentAttribute("insert", "user-123"),
            createContentAttribute("insertAt", now),
          ];
          const deleteAttrs = [
            createContentAttribute("delete", "user-123"),
            createContentAttribute("deleteAt", now),
          ];

          encodeContentMap(
            createContentMapFromContentIds(contentIds, insertAttrs, deleteAttrs),
          );
        },
        { iterations: 500 },
      );
    });

    it("single char edit, with custom attrs", async () => {
      const doc = createLargeDoc(3_000);
      const diff = generateDiff(doc, (text) => text.insert(1500, "x"));
      const wrapped = wrapUpdate(diff);

      await bench(
        "full pipeline (1 char, custom attrs)",
        () => {
          const payload = decodeContentEncryptedPayload(
            wrapped.data as EncryptedUpdatePayload,
          );
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

          encodeContentMap(
            createContentMapFromContentIds(contentIds, insertAttrs, deleteAttrs),
          );
        },
        { iterations: 500 },
      );
    });

    it("paragraph edit, no custom attrs", async () => {
      const doc = createLargeDoc(3_000);
      const diff = generateDiff(doc, (text) => text.insert(1500, paragraph));
      const wrapped = wrapUpdate(diff);
      console.log(
        `    wrapped update size: ${formatBytes((wrapped.data as Uint8Array).byteLength)}, paragraph: ${paragraph.length} chars`,
      );

      await bench(
        "full pipeline (paragraph, no custom)",
        () => {
          const payload = decodeContentEncryptedPayload(
            wrapped.data as EncryptedUpdatePayload,
          );
          const attrUpdate = {
            version: 2,
            data: payload.structureUpdate,
          } as unknown as VersionedUpdate;
          const contentIds = createContentIdsFromUpdate(attrUpdate);

          const now = Date.now();
          const insertAttrs = [
            createContentAttribute("insert", "user-123"),
            createContentAttribute("insertAt", now),
          ];
          const deleteAttrs = [
            createContentAttribute("delete", "user-123"),
            createContentAttribute("deleteAt", now),
          ];

          encodeContentMap(
            createContentMapFromContentIds(contentIds, insertAttrs, deleteAttrs),
          );
        },
        { iterations: 200 },
      );
    });

    it("paragraph edit, with custom attrs", async () => {
      const doc = createLargeDoc(3_000);
      const diff = generateDiff(doc, (text) => text.insert(1500, paragraph));
      const wrapped = wrapUpdate(diff);

      await bench(
        "full pipeline (paragraph, custom attrs)",
        () => {
          const payload = decodeContentEncryptedPayload(
            wrapped.data as EncryptedUpdatePayload,
          );
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

          encodeContentMap(
            createContentMapFromContentIds(contentIds, insertAttrs, deleteAttrs),
          );
        },
        { iterations: 200 },
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // 5. Attribution on burst of updates
  // ──────────────────────────────────────────────────────────────────────
  describe("burst of updates", () => {
    it("50 sequential single-char edits through full pipeline", async () => {
      const doc = createLargeDoc(3_000);

      // Pre-generate 50 wrapped diffs
      const wrappedUpdates: VersionedUpdate[] = [];
      for (let i = 0; i < 50; i++) {
        const diff = generateDiff(doc, (text) =>
          text.insert(Math.min(i, text.length), String.fromCharCode(97 + (i % 26))),
        );
        wrappedUpdates.push(wrapUpdate(diff));
      }

      console.log(
        `    updates: ${wrappedUpdates.length}, avg wrapped size: ${formatBytes(
          wrappedUpdates.reduce((s, u) => s + (u.data as Uint8Array).byteLength, 0) /
            wrappedUpdates.length,
        )}`,
      );

      await bench(
        "burst: 50 single-char edits full pipeline",
        () => {
          for (const wrapped of wrappedUpdates) {
            const payload = decodeContentEncryptedPayload(
              wrapped.data as EncryptedUpdatePayload,
            );
            const attrUpdate = {
              version: 2,
              data: payload.structureUpdate,
            } as unknown as VersionedUpdate;
            const contentIds = createContentIdsFromUpdate(attrUpdate);

            const now = Date.now();
            const insertAttrs = [
              createContentAttribute("insert", "user-123"),
              createContentAttribute("insertAt", now),
            ];
            const deleteAttrs = [
              createContentAttribute("delete", "user-123"),
              createContentAttribute("deleteAt", now),
            ];

            encodeContentMap(
              createContentMapFromContentIds(contentIds, insertAttrs, deleteAttrs),
            );
          }
        },
        { iterations: 100 },
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // 6. decodeContentMap (read path)
  // ──────────────────────────────────────────────────────────────────────
  describe("decodeContentMap (read path)", () => {
    it("decode contentMap from ~50 edits", async () => {
      const { insertAttrs, deleteAttrs } = createStandardAttrs();

      // Build a ContentMap from 50 edits across separate docs (distinct clients)
      const firstDoc = createLargeDoc(3_000);
      const firstDiff = generateDiff(firstDoc, (text) => text.insert(0, "a"));
      const contentMap = createContentMapFromContentIds(
        createContentIdsFromUpdate({
          version: 2,
          data: firstDiff,
        } as VersionedUpdate),
        insertAttrs,
        deleteAttrs,
      );

      for (let i = 1; i < 50; i++) {
        const doc = createLargeDoc(3_000);
        const diff = generateDiff(doc, (text) =>
          text.insert(Math.min(i, text.length), String.fromCharCode(97 + (i % 26))),
        );
        const ids = createContentIdsFromUpdate({
          version: 2,
          data: diff,
        } as VersionedUpdate);
        const partial = createContentMapFromContentIds(ids, insertAttrs, deleteAttrs);
        for (const [client, ranges] of partial.inserts.clients.entries()) {
          for (const range of ranges.getIds()) {
            contentMap.inserts.add(client, range.clock, range.len, range.attrs);
          }
        }
        for (const [client, ranges] of partial.deletes.clients.entries()) {
          for (const range of ranges.getIds()) {
            contentMap.deletes.add(client, range.clock, range.len, range.attrs);
          }
        }
      }

      const encoded = encodeContentMap(contentMap);
      console.log(
        `    encoded contentMap size: ${formatBytes(encoded.byteLength)} (50 edits)`,
      );

      await bench(
        "decodeContentMap (50 edits)",
        () => {
          decodeContentMap(encoded);
        },
        { iterations: 500 },
      );
    });
  });
});
