import { describe, expect, it } from "bun:test";
import * as Y from "yjs";
import type { UpdateV2 } from "teleportal";
import type { RpcServerContext } from "teleportal/protocol";
import type { EncodedContentMap } from "teleportal/storage";
import {
  changesetContentMap,
  createContentAttribute,
  createContentIds,
  createContentIdsFromUpdate,
  createContentMapFromContentIds,
  decodeContentMap,
  encodeContentIds,
  encodeContentMap,
  getActivity,
  mergeContentMaps,
  milestoneContentMap,
} from "teleportal/attribution";
import { createEncryptionKey, decryptUpdate, encryptUpdate } from "teleportal/encryption-key";
import { getAttributionRpcHandlers } from "./index";
import { collectRangeIds, resolveRangeAttribution } from "./resolve";

/**
 * Two-milestone scenario: snapshot s1 captures "Hello " (user-1 only); s2
 * captures "Hello World" (user-1 + user-2). `full` is the merged ContentMap.
 */
function milestoneScenario() {
  const doc1 = new Y.Doc();
  let u1!: Uint8Array;
  doc1.on("updateV2", (u) => (u1 = u));
  doc1.getText("t").insert(0, "Hello ");
  const s1 = Y.encodeStateAsUpdateV2(doc1);

  const doc2 = new Y.Doc();
  Y.applyUpdateV2(doc2, Y.encodeStateAsUpdateV2(doc1));
  let u2!: Uint8Array;
  doc2.on("updateV2", (u) => (u2 = u));
  doc2.getText("t").insert(6, "World");
  const s2 = Y.encodeStateAsUpdateV2(doc2);

  const full = mergeContentMaps([
    decodeContentMap(
      encodeContentMap(
        createContentMapFromContentIds(
          createContentIdsFromUpdate({ version: 2, data: u1 as UpdateV2 }),
          [createContentAttribute("insert", "user-1"), createContentAttribute("insertAt", 1000)],
        ),
      ),
    ),
    decodeContentMap(
      encodeContentMap(
        createContentMapFromContentIds(
          createContentIdsFromUpdate({ version: 2, data: u2 as UpdateV2 }),
          [createContentAttribute("insert", "user-2"), createContentAttribute("insertAt", 2000)],
        ),
      ),
    ),
  ]);

  return { s1, s2, full };
}

function contributors(map: Parameters<typeof getActivity>[0]): (string | null)[] {
  return [...new Set(getActivity(map).map((e) => e.userId))].sort();
}

function docFromSnapshot(snapshot: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdateV2(doc, snapshot);
  return doc;
}

/**
 * Build an encoded ContentMap attributing every operation in `update` to
 * `userId` at `timestamp` — mirrors what the server records on write.
 */
function attribute(update: Uint8Array, userId: string, timestamp: number): EncodedContentMap {
  return encodeContentMap(
    createContentMapFromContentIds(
      createContentIdsFromUpdate({ version: 2, data: update as UpdateV2 }),
      [createContentAttribute("insert", userId), createContentAttribute("insertAt", timestamp)],
      [createContentAttribute("delete", userId), createContentAttribute("deleteAt", timestamp)],
    ),
  );
}

function mockContext(
  retrieveAttribution?: () => Promise<EncodedContentMap | null>,
): RpcServerContext {
  return {
    documentId: "doc-1",
    userId: "user-1",
    server: {} as never,
    session: {
      storage: retrieveAttribution ? { retrieveAttribution } : {},
    },
  } as unknown as RpcServerContext;
}

/**
 * Two users edit a shared Y.Text: user-1 writes "Hello ", user-2 appends
 * "World". Returns the merged ContentMap plus the doc holding both edits.
 */
function twoUserDoc() {
  const doc1 = new Y.Doc();
  let u1!: Uint8Array;
  doc1.on("updateV2", (u) => (u1 = u));
  doc1.getText("t").insert(0, "Hello ");

  const doc2 = new Y.Doc();
  Y.applyUpdateV2(doc2, Y.encodeStateAsUpdateV2(doc1));
  let u2!: Uint8Array;
  doc2.on("updateV2", (u) => (u2 = u));
  doc2.getText("t").insert(6, "World");

  const map = mergeContentMaps([
    decodeContentMap(attribute(u1, "user-1", 1000)),
    decodeContentMap(attribute(u2, "user-2", 2000)),
  ]);

  return { doc: doc2, text: doc2.getText("t"), map };
}

describe("getAttributionRpcHandlers", () => {
  it("registers both read methods", () => {
    const handlers = getAttributionRpcHandlers();
    expect("attributionActivity" in handlers).toBe(true);
    expect("attributionGet" in handlers).toBe(true);
  });

  describe("attributionActivity", () => {
    it("returns a timeline from stored attribution", async () => {
      const { map } = twoUserDoc();
      const encoded = encodeContentMap(map);
      const handler = getAttributionRpcHandlers().attributionActivity;

      const { response } = (await handler.handler(
        {},
        mockContext(async () => encoded),
      )) as { response: { activity: { userId: string | null }[] } };

      const users = response.activity.map((e) => e.userId).sort();
      expect(users).toEqual(["user-1", "user-2"]);
    });

    it("applies the userId filter", async () => {
      const { map } = twoUserDoc();
      const encoded = encodeContentMap(map);
      const handler = getAttributionRpcHandlers().attributionActivity;

      const { response } = (await handler.handler(
        { userId: "user-2" },
        mockContext(async () => encoded),
      )) as { response: { activity: { userId: string | null }[] } };

      expect(response.activity.map((e) => e.userId)).toEqual(["user-2"]);
    });

    it("returns an empty timeline when the storage has no attribution", async () => {
      const handler = getAttributionRpcHandlers().attributionActivity;
      const { response } = (await handler.handler({}, mockContext())) as {
        response: { activity: unknown[] };
      };
      expect(response.activity).toEqual([]);
    });

  });

  describe("attributionGet", () => {
    it("returns the stored ContentMap unchanged when unfiltered", async () => {
      const { map } = twoUserDoc();
      const encoded = encodeContentMap(map);
      const handler = getAttributionRpcHandlers().attributionGet;

      const { response } = (await handler.handler(
        {},
        mockContext(async () => encoded),
      )) as { response: { contentMap: EncodedContentMap | null } };

      expect(response.contentMap).toBe(encoded);
    });

    it("narrows the ContentMap by filter", async () => {
      const { map } = twoUserDoc();
      const encoded = encodeContentMap(map);
      const handler = getAttributionRpcHandlers().attributionGet;

      const { response } = (await handler.handler(
        { filter: { userId: "user-1" } },
        mockContext(async () => encoded),
      )) as { response: { contentMap: EncodedContentMap | null } };

      const decoded = decodeContentMap(response.contentMap!);
      // Only user-1's client should remain in the inserts.
      const remaining = [...decoded.inserts.clients.values()].flatMap((r) =>
        r
          .getIds()
          .flatMap((range) =>
            range.attrs.filter((a) => a.name === "insert").map((a) => a.val as string),
          ),
      );
      expect([...new Set(remaining)]).toEqual(["user-1"]);
    });

    it("returns null when the storage has no attribution", async () => {
      const handler = getAttributionRpcHandlers().attributionGet;
      const { response } = (await handler.handler({}, mockContext())) as {
        response: { contentMap: EncodedContentMap | null };
      };
      expect(response.contentMap).toBeNull();
    });

    it("narrows the ContentMap by custom attributes", async () => {
      const ids1 = createContentIds();
      ids1.inserts.add(1, 0, 5);
      const map1 = createContentMapFromContentIds(ids1, [
        createContentAttribute("insert", "user-1"),
        createContentAttribute("insertAt", 1000),
        createContentAttribute("source", "ai"),
      ]);

      const ids2 = createContentIds();
      ids2.inserts.add(2, 0, 3);
      const map2 = createContentMapFromContentIds(ids2, [
        createContentAttribute("insert", "user-1"),
        createContentAttribute("insertAt", 2000),
        createContentAttribute("source", "human"),
      ]);

      const merged = mergeContentMaps([map1, map2]);
      const encoded = encodeContentMap(merged);
      const handler = getAttributionRpcHandlers().attributionGet;

      const { response } = (await handler.handler(
        { filter: { attributes: { source: "ai" } } },
        mockContext(async () => encoded),
      )) as { response: { contentMap: EncodedContentMap | null } };

      const decoded = decodeContentMap(response.contentMap!);
      const sources = [...decoded.inserts.clients.values()].flatMap((r) =>
        r
          .getIds()
          .flatMap((range) =>
            range.attrs.filter((a) => a.name === "source").map((a) => a.val as string),
          ),
      );
      expect([...new Set(sources)]).toEqual(["ai"]);
    });
  });
});

describe("resolveRangeAttribution", () => {
  it("attributes content ranges to the correct authors", () => {
    const { text, map } = twoUserDoc();

    const hello = resolveRangeAttribution(text, 0, 6, map);
    expect(hello).toEqual([
      {
        from: 0,
        to: 6,
        userId: "user-1",
        timestamp: 1000,
        attributes: { insert: "user-1", insertAt: 1000 },
      },
    ]);

    const world = resolveRangeAttribution(text, 6, 5, map);
    expect(world).toEqual([
      {
        from: 6,
        to: 11,
        userId: "user-2",
        timestamp: 2000,
        attributes: { insert: "user-2", insertAt: 2000 },
      },
    ]);
  });

  it("splits a range spanning both authors", () => {
    const { text, map } = twoUserDoc();
    const all = resolveRangeAttribution(text, 0, 11, map);
    expect(all).toEqual([
      {
        from: 0,
        to: 6,
        userId: "user-1",
        timestamp: 1000,
        attributes: { insert: "user-1", insertAt: 1000 },
      },
      {
        from: 6,
        to: 11,
        userId: "user-2",
        timestamp: 2000,
        attributes: { insert: "user-2", insertAt: 2000 },
      },
    ]);
  });

  it("includes custom attributes on segments", () => {
    const doc = new Y.Doc();
    let u!: Uint8Array;
    doc.on("updateV2", (update: Uint8Array) => (u = update));
    doc.getText("t").insert(0, "Hello");

    const map = decodeContentMap(
      encodeContentMap(
        createContentMapFromContentIds(
          createContentIdsFromUpdate({ version: 2, data: u as UpdateV2 }),
          [
            createContentAttribute("insert", "user-1"),
            createContentAttribute("insertAt", 1000),
            createContentAttribute("source", "ai"),
          ],
        ),
      ),
    );

    const segments = resolveRangeAttribution(doc.getText("t"), 0, 5, map);
    expect(segments.length).toBe(1);
    expect(segments[0].attributes).toEqual({
      insert: "user-1",
      insertAt: 1000,
      source: "ai",
    });
  });

  it("does not merge adjacent segments with different custom attributes", () => {
    const doc = new Y.Doc();
    const updates: Uint8Array[] = [];
    doc.on("updateV2", (u: Uint8Array) => updates.push(u));
    doc.getText("t").insert(0, "AB");

    const doc2 = new Y.Doc();
    const updates2: Uint8Array[] = [];
    doc2.on("updateV2", (u: Uint8Array) => updates2.push(u));
    doc2.getText("t").insert(0, "A");

    const doc3 = new Y.Doc();
    Y.applyUpdateV2(doc3, Y.encodeStateAsUpdateV2(doc2));
    const updates3: Uint8Array[] = [];
    doc3.on("updateV2", (u: Uint8Array) => updates3.push(u));
    doc3.getText("t").insert(1, "B");

    const splitMap = mergeContentMaps([
      decodeContentMap(
        encodeContentMap(
          createContentMapFromContentIds(
            createContentIdsFromUpdate({ version: 2, data: updates2[0] as UpdateV2 }),
            [
              createContentAttribute("insert", "user-1"),
              createContentAttribute("insertAt", 1000),
              createContentAttribute("source", "ai"),
            ],
          ),
        ),
      ),
      decodeContentMap(
        encodeContentMap(
          createContentMapFromContentIds(
            createContentIdsFromUpdate({ version: 2, data: updates3[0] as UpdateV2 }),
            [
              createContentAttribute("insert", "user-1"),
              createContentAttribute("insertAt", 1000),
              createContentAttribute("source", "human"),
            ],
          ),
        ),
      ),
    ]);

    const segments = resolveRangeAttribution(doc3.getText("t"), 0, 2, splitMap);
    expect(segments.length).toBe(2);
    expect(segments[0].attributes["source"]).toBe("ai");
    expect(segments[1].attributes["source"]).toBe("human");
  });

  it("collectRangeIds skips deleted content", () => {
    const doc = new Y.Doc();
    const text = doc.getText("t");
    text.insert(0, "abcdef");
    text.delete(1, 2); // remove "bc" -> visible "adef"

    const ids = collectRangeIds(text, 0, 4);
    const total = ids.reduce((n, id) => n + id.len, 0);
    expect(total).toBe(4);
  });
});

describe("milestone-scoped attribution", () => {
  it("attributes the content present in a milestone", () => {
    const { s1, s2, full } = milestoneScenario();

    const m1 = milestoneContentMap(
      full,
      createContentIdsFromUpdate({ version: 2, data: s1 as UpdateV2 }),
    );
    expect(contributors(m1)).toEqual(["user-1"]);

    const m2 = milestoneContentMap(
      full,
      createContentIdsFromUpdate({ version: 2, data: s2 as UpdateV2 }),
    );
    expect(contributors(m2)).toEqual(["user-1", "user-2"]);
  });

  it("attributes the changeset between two milestones", () => {
    const { s1, s2, full } = milestoneScenario();
    const changeset = changesetContentMap(
      full,
      createContentIdsFromUpdate({ version: 2, data: s1 as UpdateV2 }),
      createContentIdsFromUpdate({ version: 2, data: s2 as UpdateV2 }),
    );
    expect(contributors(changeset)).toEqual(["user-2"]);
  });

  it("resolves a content range as it existed in a milestone", () => {
    const { s1, s2, full } = milestoneScenario();

    // As of milestone 1 the text is just "Hello " — all user-1.
    const m1Doc = docFromSnapshot(s1);
    expect(resolveRangeAttribution(m1Doc.getText("t"), 0, 6, full)).toEqual([
      {
        from: 0,
        to: 6,
        userId: "user-1",
        timestamp: 1000,
        attributes: { insert: "user-1", insertAt: 1000 },
      },
    ]);

    // As of milestone 2, "World" is user-2.
    const m2Doc = docFromSnapshot(s2);
    expect(resolveRangeAttribution(m2Doc.getText("t"), 6, 5, full)).toEqual([
      {
        from: 6,
        to: 11,
        userId: "user-2",
        timestamp: 2000,
        attributes: { insert: "user-2", insertAt: 2000 },
      },
    ]);
  });

  it("recovers milestone IDs after an encrypt/decrypt round-trip", async () => {
    const { s2 } = milestoneScenario();
    const key = await createEncryptionKey();

    const encrypted = await encryptUpdate(key, s2);
    const decrypted = await decryptUpdate(key, encrypted);

    // The ciphertext must not equal the plaintext snapshot...
    expect(encrypted).not.toEqual(s2);
    // ...but the decrypted snapshot yields identical operation IDs.
    expect(
      encodeContentIds(createContentIdsFromUpdate({ version: 2, data: decrypted as UpdateV2 })),
    ).toEqual(encodeContentIds(createContentIdsFromUpdate({ version: 2, data: s2 as UpdateV2 })));
  });
});
