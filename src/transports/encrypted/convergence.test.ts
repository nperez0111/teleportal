import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as Y from "yjs";
import { createEncryptionKey } from "teleportal/encryption-key";
import {
  InMemoryPubSub,
  type Message,
  type ServerContext,
  type Update,
  type VersionedUpdate,
  type VersionedSyncStep2Update,
} from "teleportal";
import { MemoryDocumentStorage } from "teleportal/storage";
import { Server } from "../../server/server";
import { Client } from "../../server/client";
import type { Session } from "../../server/session";
import { EncryptionClient } from "./client";

type Ctx = ServerContext;

/**
 * Convergence + edge-case tests for the content-level-encryption transport
 * (EncryptionClient). These use the same in-process session/inbox harness as
 * e2e.test.ts ("encrypted sync e2e: two clients via server"), but exercise
 * scenarios that file does not cover: 3-client concurrent edits across multiple
 * Y.js types, late joiners reconstructing from scratch, wrong-key isolation,
 * offline buffering, and compaction-threshold reconstruction.
 *
 * The server stores documents in MemoryDocumentStorage under the namespaced key
 * `${room}/${document}`. With room "default" and document "doc-1" the stored key
 * is "default/doc-1".
 */
describe("encrypted convergence (in-process session harness)", () => {
  let storage: MemoryDocumentStorage;
  let pubSub: InMemoryPubSub;
  let server: Server<Ctx>;
  let key: CryptoKey;
  const STORAGE_KEY = "default/doc-1";

  beforeEach(async () => {
    MemoryDocumentStorage.docs.clear();
    MemoryDocumentStorage.pendingUpdates.clear();
    MemoryDocumentStorage.attributionMaps.clear();
    storage = new MemoryDocumentStorage(true);
    pubSub = new InMemoryPubSub();
    key = await createEncryptionKey();

    server = new Server<Ctx>({
      storage: async () => storage,
      pubSub,
    });
  });

  afterEach(async () => {
    await server[Symbol.asyncDispose]();
    await pubSub[Symbol.asyncDispose]();
  });

  // ── Harness helpers (mirrors e2e.test.ts) ──────────────────────────────────

  function createServerClient(id: string, onMessage: (msg: Message<Ctx>) => void): Client<Ctx> {
    return new Client<Ctx>({ id, write: (chunk) => onMessage(chunk) });
  }

  type Peer = {
    enc: EncryptionClient;
    ydoc: Y.Doc;
    serverClient: Client<Ctx>;
    inbox: Message<Ctx>[];
    id: string;
  };

  /**
   * Create an EncryptionClient peer wired to the server session. The first peer
   * opens the session; subsequent peers are added via addClient.
   */
  async function createPeer(
    id: string,
    opts?: { key?: CryptoKey; ydoc?: Y.Doc; session?: Session<Ctx> },
  ): Promise<{ peer: Peer; session: Session<Ctx> }> {
    const ydoc = opts?.ydoc ?? new Y.Doc();
    const enc = new EncryptionClient({ document: "doc-1", ydoc, key: opts?.key ?? key });
    const inbox: Message<Ctx>[] = [];
    const serverClient = createServerClient(id, (msg) => inbox.push(msg));

    let session = opts?.session;
    if (!session) {
      session = await server.getOrOpenSession("doc-1", {
        encrypted: true,
        client: serverClient,
        context: { userId: id, room: "default", clientId: id },
      });
      await session.load();
    } else {
      session.addClient(serverClient);
    }

    return { peer: { enc, ydoc, serverClient, inbox, id }, session };
  }

  async function performSyncHandshake(peer: Peer, session: Session<Ctx>) {
    const syncStep1 = await peer.enc.start();
    peer.inbox.length = 0;
    await session.apply(syncStep1 as Message<Ctx>, peer.serverClient);

    for (const msg of peer.inbox) {
      if (msg.type !== "doc") continue;
      if (msg.payload.type === "sync-step-2") {
        await peer.enc.handleSyncStep2(msg.payload.update as unknown as VersionedSyncStep2Update);
      } else if (msg.payload.type === "sync-step-1") {
        const resp = await peer.enc.handleSyncStep1(msg.payload.sv as unknown as Uint8Array);
        peer.inbox.length = 0;
        await session.apply(resp as Message<Ctx>, peer.serverClient);
      }
    }
  }

  /** Send the full local state as an encrypted update to the server. */
  async function sendUpdate(peer: Peer, session: Session<Ctx>) {
    const update = {
      version: 2,
      data: Y.encodeStateAsUpdateV2(peer.ydoc) as Update,
    } as VersionedUpdate;
    const msg = await peer.enc.onUpdate(update);
    await session.apply(msg as Message<Ctx>, peer.serverClient);
  }

  /** Apply every broadcasted "update" message currently in the inbox, then clear it. */
  async function drainInbox(peer: Peer) {
    for (const msg of peer.inbox) {
      if (msg.type !== "doc") continue;
      if (msg.payload.type === "update") {
        await peer.enc.handleUpdate(msg.payload.update as unknown as VersionedUpdate);
      } else if (msg.payload.type === "sync-step-2") {
        await peer.enc.handleSyncStep2(msg.payload.update as unknown as VersionedSyncStep2Update);
      }
    }
    peer.inbox.length = 0;
  }

  /**
   * Canonical JSON of a Y.Doc for cross-peer equality.
   *
   * NOTE: `Y.Doc.toJSON()` only serializes top-level shared types that have been
   * instantiated on *that* doc instance via a `get*` call. Two peers can hold
   * byte-identical state yet produce different `toJSON()` output simply because
   * each only ever `.get()`-accessed its own field. To compare real document
   * content we first instantiate every field we care about on each doc.
   */
  function canonicalState(
    ydoc: Y.Doc,
    fields: { text?: string[]; map?: string[]; array?: string[] },
  ) {
    for (const f of fields.text ?? []) ydoc.getText(f);
    for (const f of fields.map ?? []) ydoc.getMap(f);
    for (const f of fields.array ?? []) ydoc.getArray(f);
    // Sort keys recursively: toJSON() key order reflects the order each peer
    // first instantiated its top-level types, which is irrelevant to convergence.
    return stableStringify(ydoc.toJSON());
  }

  function stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
      return `[${value.map(stableStringify).join(",")}]`;
    }
    if (value && typeof value === "object") {
      const keys = Object.keys(value as Record<string, unknown>).sort();
      return `{${keys
        .map(
          (k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`,
        )
        .join(",")}}`;
    }
    return JSON.stringify(value);
  }

  function clearInboxes(...peers: Peer[]) {
    for (const p of peers) p.inbox.length = 0;
  }

  function containsSubarray(haystack: Uint8Array, needle: Uint8Array): boolean {
    if (needle.length === 0) return true;
    outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) {
        if (haystack[i + j] !== needle[j]) continue outer;
      }
      return true;
    }
    return false;
  }

  /** Assert that no stored byte (structure update or any sidecar) contains marker. */
  async function assertServerHasNoPlaintext(marker: string) {
    const state = await storage.getDocumentState(STORAGE_KEY);
    expect(state).not.toBeNull();
    const needle = new TextEncoder().encode(marker);
    expect(containsSubarray(new Uint8Array(state!.update), needle)).toBe(false);
    for (const sidecar of state!.sidecars) {
      expect(containsSubarray(new Uint8Array(sidecar.encrypted), needle)).toBe(false);
    }
    // Applying only the structure update (no sidecars) must not reveal the marker.
    const stripped = new Y.Doc();
    if (state!.update.length > 0) Y.applyUpdateV2(stripped, state!.update);
    expect(JSON.stringify(stripped.toJSON())).not.toContain(marker);
  }

  // ── Scenario 1: three concurrent editors (text + map + array) ──────────────

  it("three clients editing text/map/array concurrently all converge; server stays opaque", async () => {
    const MARKER_A = "ALPHA_secret_111";
    const MARKER_B = "BRAVO_secret_222";
    const MARKER_C = "CHARLIE_secret_333";

    const { peer: a, session } = await createPeer("client-a");
    await performSyncHandshake(a, session);

    const { peer: b } = await createPeer("client-b", { session });
    await performSyncHandshake(b, session);

    const { peer: c } = await createPeer("client-c", { session });
    await performSyncHandshake(c, session);

    // Concurrent edits across three different shared types.
    a.ydoc.getText("body").insert(0, MARKER_A);
    b.ydoc.getMap("settings").set("name", MARKER_B);
    b.ydoc.getMap("settings").set("count", 42);
    c.ydoc.getArray("items").push([MARKER_C, "x", "y"]);

    clearInboxes(a, b, c);
    await sendUpdate(a, session);
    await sendUpdate(b, session);
    await sendUpdate(c, session);

    // Each peer applies whatever the server broadcast to it. Repeat a couple of
    // rounds so any update produced during draining is also propagated.
    for (let round = 0; round < 3; round++) {
      await drainInbox(a);
      await drainInbox(b);
      await drainInbox(c);
    }

    // All three Y.Docs converge to identical content across every shared type.
    const fields = { text: ["body"], map: ["settings"], array: ["items"] };
    const jsonA = canonicalState(a.ydoc, fields);
    const jsonB = canonicalState(b.ydoc, fields);
    const jsonC = canonicalState(c.ydoc, fields);
    expect(jsonA).toBe(jsonB);
    expect(jsonB).toBe(jsonC);

    // And the converged content includes every contribution.
    expect(a.ydoc.getText("body").toString()).toBe(MARKER_A);
    expect(a.ydoc.getMap("settings").get("name")).toBe(MARKER_B);
    expect(a.ydoc.getMap("settings").get("count")).toBe(42);
    expect(a.ydoc.getArray("items").toArray()).toEqual([MARKER_C, "x", "y"]);

    // Server never saw plaintext for any of the three markers.
    await assertServerHasNoPlaintext(MARKER_A);
    await assertServerHasNoPlaintext(MARKER_B);
    await assertServerHasNoPlaintext(MARKER_C);

    a.enc.destroy();
    b.enc.destroy();
    c.enc.destroy();
  });

  // ── Scenario 2: late joiner reconstructs full converged state ──────────────

  it("a late-joining client syncs from scratch and reconstructs the full converged state", async () => {
    const { peer: a, session } = await createPeer("client-a");
    await performSyncHandshake(a, session);

    const { peer: b } = await createPeer("client-b", { session });
    await performSyncHandshake(b, session);

    // Two peers build up state across several shared types and multiple updates.
    a.ydoc.getText("body").insert(0, "hello");
    clearInboxes(a, b);
    await sendUpdate(a, session);
    await drainInbox(b);

    b.ydoc.getText("body").insert(5, " world");
    b.ydoc.getMap("meta").set("title", "Doc Title");
    clearInboxes(a, b);
    await sendUpdate(b, session);
    await drainInbox(a);

    a.ydoc.getArray("tags").push(["red", "green"]);
    clearInboxes(a, b);
    await sendUpdate(a, session);
    await drainInbox(b);

    const fields = { text: ["body"], map: ["meta"], array: ["tags"] };
    const expectedJson = canonicalState(a.ydoc, fields);
    expect(canonicalState(b.ydoc, fields)).toBe(expectedJson);

    // Late joiner: brand new Y.Doc, syncs from scratch.
    const { peer: late } = await createPeer("client-late", { session });
    await performSyncHandshake(late, session);
    await drainInbox(late);

    expect(late.ydoc.getText("body").toString()).toBe("hello world");
    expect(late.ydoc.getMap("meta").get("title")).toBe("Doc Title");
    expect(late.ydoc.getArray("tags").toArray()).toEqual(["red", "green"]);
    expect(canonicalState(late.ydoc, fields)).toBe(expectedJson);

    a.enc.destroy();
    b.enc.destroy();
    late.enc.destroy();
  });

  // ── Scenario 3: wrong-key client cannot read & does not corrupt others ──────

  it("a wrong-key client cannot read content and does not corrupt correct-key clients", async () => {
    const SECRET = "TOP_SECRET_payload_999";
    const wrongKey = await createEncryptionKey();

    const { peer: a, session } = await createPeer("client-a");
    await performSyncHandshake(a, session);

    a.ydoc.getText("body").insert(0, SECRET);
    clearInboxes(a);
    await sendUpdate(a, session);

    // Correct-key late joiner reads the content fine.
    const { peer: good } = await createPeer("client-good", { session });
    await performSyncHandshake(good, session);
    await drainInbox(good);
    expect(good.ydoc.getText("body").toString()).toBe(SECRET);

    // Wrong-key client attempts to sync. Its sync-step-2 handling must fail to
    // decrypt rather than silently producing garbage, and its Y.Doc must not
    // contain the plaintext.
    const { peer: bad } = await createPeer("client-bad", { key: wrongKey, session });

    let wrongKeyRejected = false;
    try {
      await performSyncHandshake(bad, session);
      await drainInbox(bad);
    } catch {
      wrongKeyRejected = true;
    }
    expect(wrongKeyRejected).toBe(true);
    expect(bad.ydoc.getText("body").toString()).not.toBe(SECRET);
    expect(JSON.stringify(bad.ydoc.toJSON())).not.toContain(SECRET);

    // Critically: the wrong-key path must not corrupt server state. A fresh
    // correct-key client still reconstructs the exact original content.
    const { peer: verify } = await createPeer("client-verify", { session });
    await performSyncHandshake(verify, session);
    await drainInbox(verify);
    expect(verify.ydoc.getText("body").toString()).toBe(SECRET);

    // And the existing correct-key client is unaffected.
    await drainInbox(good);
    expect(good.ydoc.getText("body").toString()).toBe(SECRET);

    a.enc.destroy();
    good.enc.destroy();
    bad.enc.destroy();
    verify.enc.destroy();
  });

  // ── Scenario 4: offline edits buffered then flushed ────────────────────────

  it("offline edits buffered then flushed converge to identical state", async () => {
    const { peer: a, session } = await createPeer("client-a");
    await performSyncHandshake(a, session);

    const { peer: b } = await createPeer("client-b", { session });
    await performSyncHandshake(b, session);

    // B goes "offline": it makes several local edits but does NOT send them.
    // (We simulate offline by simply not calling sendUpdate until later.)
    b.ydoc.getText("body").insert(0, "offline-1 ");
    b.ydoc.getText("body").insert(b.ydoc.getText("body").length, "offline-2 ");
    b.ydoc.getMap("state").set("dirty", true);
    b.ydoc.getText("body").insert(b.ydoc.getText("body").length, "offline-3");

    // Meanwhile A edits and sends while B is offline.
    a.ydoc.getText("title").insert(0, "online edit");
    clearInboxes(a, b);
    await sendUpdate(a, session);
    // B's inbox now has A's update queued but B has not applied it yet (offline).

    // B comes back online: first flush its buffered local state to the server as
    // a single update, then drain whatever the server has for it.
    clearInboxes(a);
    await sendUpdate(b, session); // flush buffered offline edits
    await drainInbox(b); // receive A's online edit (was queued) + echoes
    await drainInbox(a); // A receives B's flushed edits

    // A few settle rounds for any follow-on broadcasts.
    for (let round = 0; round < 2; round++) {
      await drainInbox(a);
      await drainInbox(b);
    }

    expect(a.ydoc.getText("body").toString()).toBe("offline-1 offline-2 offline-3");
    expect(a.ydoc.getText("title").toString()).toBe("online edit");
    expect(a.ydoc.getMap("state").get("dirty")).toBe(true);
    const fields = { text: ["body", "title"], map: ["state"] };
    expect(canonicalState(a.ydoc, fields)).toBe(canonicalState(b.ydoc, fields));

    a.enc.destroy();
    b.enc.destroy();
  });

  // ── Scenario 5: compaction threshold then fresh client reconstructs ────────

  it("drives enough updates to trigger compaction; a fresh client still reconstructs exact state", async () => {
    const originalThreshold = EncryptionClient.COMPACTION_THRESHOLD;
    // Lower the threshold so the test runs quickly but still crosses it.
    EncryptionClient.COMPACTION_THRESHOLD = 5;

    try {
      const { peer: a, session } = await createPeer("client-a");
      await performSyncHandshake(a, session);

      const { peer: b } = await createPeer("client-b", { session });
      await performSyncHandshake(b, session);

      // Drive well past the threshold of incremental updates between two peers.
      // Each edit produces one sidecar; crossing COMPACTION_THRESHOLD triggers
      // an incremental compaction that piggy-backs on a later outgoing message.
      const N = EncryptionClient.COMPACTION_THRESHOLD * 3; // 15 edits
      for (let i = 0; i < N; i++) {
        const writer = i % 2 === 0 ? a : b;
        const reader = i % 2 === 0 ? b : a;
        writer.ydoc.getText("body").insert(writer.ydoc.getText("body").length, `${i},`);
        clearInboxes(a, b);
        await sendUpdate(writer, session);
        await drainInbox(reader);
        // Drain the writer too so any compaction it produced is sent on its next turn.
        await drainInbox(writer);
      }

      // Settle.
      for (let round = 0; round < 3; round++) {
        await drainInbox(a);
        await drainInbox(b);
      }

      const expected = Array.from({ length: N }, (_, i) => `${i},`).join("");
      const fields = { text: ["body"] };
      expect(a.ydoc.getText("body").toString()).toBe(expected);
      expect(b.ydoc.getText("body").toString()).toBe(expected);
      expect(canonicalState(a.ydoc, fields)).toBe(canonicalState(b.ydoc, fields));

      // A fresh client syncing from scratch must reconstruct the exact state,
      // regardless of how the server compacted sidecars internally.
      const { peer: fresh } = await createPeer("client-fresh", { session });
      await performSyncHandshake(fresh, session);
      await drainInbox(fresh);

      expect(fresh.ydoc.getText("body").toString()).toBe(expected);
      expect(canonicalState(fresh.ydoc, fields)).toBe(canonicalState(a.ydoc, fields));

      a.enc.destroy();
      b.enc.destroy();
      fresh.enc.destroy();
    } finally {
      EncryptionClient.COMPACTION_THRESHOLD = originalThreshold;
    }
  });
});
