import { beforeEach, describe, expect, it } from "bun:test";
import * as Y from "yjs";
import {
  type BinaryMessage,
  DocMessage,
  InMemoryPubSub,
  type Message,
  type PublishOptions,
  type PubSubTopic,
  type ServerContext,
  type StateVector,
  type SubscribeOptions,
  type SyncStep2UpdateV2,
  type Update,
  type VersionedSyncStep2Update,
} from "teleportal";
import type {
  Document,
  DocumentMetadata,
  DocumentStorage,
  EncodedContentMap,
} from "teleportal/storage";
import { Server } from "./server";
import { Session } from "./session";

// A local client double that records what the session sends it.
class MockClient<Context extends ServerContext> {
  public sentMessages: Message<Context>[] = [];
  constructor(public id: string) {}
  async send(message: Message<Context>) {
    this.sentMessages.push(message);
  }
  destroy() {}
}

/**
 * Storage stub whose full-state read (`handleSyncStep1` with the empty state vector) returns a
 * configurable raw Y UpdateV2, so a client applying the resulting sync-step-2 converges to a
 * known document. Counts full-state reads to prove resync coalescing.
 */
class StubStorage implements DocumentStorage {
  readonly type = "document-storage" as const;
  storageType: "encrypted" | "unencrypted" = "unencrypted";
  fileStorage = undefined;

  public fullStateReads = 0;
  /** When set, the first full-state read blocks on this promise (to overlap concurrent gaps). */
  public gateFirstRead: Promise<void> | undefined;
  #gatedOnce = false;
  constructor(private fullState: Uint8Array) {}

  setFullState(update: Uint8Array) {
    this.fullState = update;
  }

  async handleSyncStep1(documentId: string, sv: StateVector): Promise<Document> {
    this.fullStateReads++;
    if (this.gateFirstRead && !this.#gatedOnce) {
      this.#gatedOnce = true;
      await this.gateFirstRead;
    }
    return {
      id: documentId,
      metadata: await this.getDocumentMetadata(documentId),
      content: { update: this.fullState as unknown as Update, stateVector: sv },
    };
  }
  async handleSyncStep2(): Promise<void> {}
  async handleUpdate(): Promise<void> {}
  async retrieveAttribution(): Promise<EncodedContentMap | null> {
    return null;
  }
  async getDocument(): Promise<Document | null> {
    return null;
  }
  async writeDocumentMetadata(): Promise<void> {}
  async getDocumentMetadata(_documentId: string): Promise<DocumentMetadata> {
    return { createdAt: 0, updatedAt: 0, encrypted: false };
  }
  async deleteDocument(): Promise<void> {}
  transaction<T>(_documentId: string, cb: () => Promise<T>): Promise<T> {
    return cb();
  }
  async addFileToDocument(): Promise<void> {}
  async removeFileFromDocument(): Promise<void> {}
}

/**
 * A minimal PubSub double that lets a test capture the per-topic `onGap` callback and fire it
 * on demand — standing in for a durable backend that detected an unrecoverable retention gap.
 */
class ControllablePubSub {
  #subs = new Map<
    PubSubTopic,
    Set<{ cb: (m: BinaryMessage, s: string) => void; onGap?: (t: PubSubTopic) => void }>
  >();

  public failPublishes = false;
  public published: Array<{ topic: PubSubTopic; message: BinaryMessage; sourceId: string }> = [];

  async publish(
    topic: PubSubTopic,
    message: BinaryMessage,
    sourceId: string,
    _options?: PublishOptions,
  ): Promise<void> {
    if (this.failPublishes) {
      throw new Error("publish failed (simulated node disconnect)");
    }
    this.published.push({ topic, message, sourceId });
    for (const s of this.#subs.get(topic) ?? []) s.cb(message, sourceId);
  }

  async subscribe(
    topic: PubSubTopic,
    cb: (m: BinaryMessage, s: string) => void,
    options?: SubscribeOptions,
  ): Promise<() => Promise<void>> {
    const entry = { cb, onGap: options?.onGap };
    let set = this.#subs.get(topic);
    if (!set) {
      set = new Set();
      this.#subs.set(topic, set);
    }
    set.add(entry);
    return async () => {
      set!.delete(entry);
    };
  }

  triggerGap(topic: PubSubTopic) {
    for (const s of this.#subs.get(topic) ?? []) s.onGap?.(topic);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.#subs.clear();
  }
}

function createMockServer(): Server<ServerContext> {
  return new Server<ServerContext>({
    storage: async () => {
      throw new Error("Not implemented in mock");
    },
  });
}

/** Raw Y UpdateV2 of a doc whose "content" text equals `text`. */
function yUpdate(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, text);
  return Y.encodeStateAsUpdateV2(doc);
}

const topic = "document/test-doc" as PubSubTopic;

describe("Session durability / gap heal", () => {
  let server: Server<ServerContext>;

  beforeEach(() => {
    server = createMockServer();
  });

  function makeSession(storage: DocumentStorage, pubSub: any, nodeId = "node-1") {
    return new Session<ServerContext>({
      documentId: "test-doc",
      namespacedDocumentId: "test-doc",
      id: `session-${nodeId}`,
      encrypted: false,
      storage,
      pubSub,
      nodeId,
      onCleanupScheduled: () => {},
      server,
    });
  }

  it("resync pushes a full-state sync-step-2 that converges a fresh Y.Doc", async () => {
    const storage = new StubStorage(yUpdate("hello"));
    const pubSub = new InMemoryPubSub();
    const session = makeSession(storage, pubSub);
    const client = new MockClient<ServerContext>("client-1");
    await session.load();
    session.addClient(client as any);

    await session.resyncLocalClientsFromStorage();

    const syncStep2 = client.sentMessages.find((m) => (m as any).payload?.type === "sync-step-2");
    expect(syncStep2).toBeDefined();

    const fresh = new Y.Doc();
    Y.applyUpdateV2(fresh, (syncStep2 as any).payload.update.data);
    expect(fresh.getText("content").toString()).toBe("hello");

    await session[Symbol.asyncDispose]();
    await pubSub[Symbol.asyncDispose]();
  });

  it("onGap emits replication-gap and triggers a coalesced resync", async () => {
    const storage = new StubStorage(yUpdate("state"));
    const pubSub = new ControllablePubSub();
    const session = makeSession(storage, pubSub);
    const client = new MockClient<ServerContext>("client-1");

    let gapEvents = 0;
    session.on("replication-gap", () => gapEvents++);

    await session.load();
    session.addClient(client as any);

    // Several gaps fire back-to-back (flapping connection). Coalescing must collapse them: at
    // most one in-flight run plus one trailing re-run — never one storage read per gap.
    pubSub.triggerGap(topic);
    pubSub.triggerGap(topic);
    pubSub.triggerGap(topic);
    pubSub.triggerGap(topic);

    // Let the resync(s) settle.
    await new Promise((r) => setTimeout(r, 1));

    expect(gapEvents).toBe(4);
    expect(storage.fullStateReads).toBeGreaterThanOrEqual(1);
    expect(storage.fullStateReads).toBeLessThanOrEqual(2);
    expect(
      client.sentMessages.filter((m) => (m as any).payload?.type === "sync-step-2").length,
    ).toBe(storage.fullStateReads);

    await session[Symbol.asyncDispose]();
    await pubSub[Symbol.asyncDispose]();
  });

  it("plain-backend regression: normal traffic never emits replication-gap", async () => {
    const storage = new StubStorage(yUpdate("x"));
    const pubSub = new InMemoryPubSub();
    const session = makeSession(storage, pubSub);
    const client = new MockClient<ServerContext>("client-1");

    let gapEvents = 0;
    session.on("replication-gap", () => gapEvents++);

    await session.load();
    session.addClient(client as any);

    // A normal cross-node update arrives over the plain in-memory backend.
    const update = new DocMessage(
      "test-doc",
      {
        type: "sync-step-2",
        update: { version: 2, data: yUpdate("x") as unknown as SyncStep2UpdateV2 },
      } as { type: "sync-step-2"; update: VersionedSyncStep2Update },
      { clientId: "other", userId: "u", room: "r" },
    );
    await pubSub.publish(topic, update.encoded, "node-2");
    await new Promise((r) => setTimeout(r, 1));

    expect(gapEvents).toBe(0);

    await session[Symbol.asyncDispose]();
    await pubSub[Symbol.asyncDispose]();
  });

  it("re-runs the resync when a gap fires while one is already in flight", async () => {
    const storage = new StubStorage(yUpdate("state"));
    const pubSub = new ControllablePubSub();
    const session = makeSession(storage, pubSub);
    const client = new MockClient<ServerContext>("client-1");
    await session.load();
    session.addClient(client as any);

    // Gate the first storage read so the first resync is still in flight when the second gap fires.
    let release!: () => void;
    storage.gateFirstRead = new Promise<void>((r) => (release = r));

    pubSub.triggerGap(topic); // G1: starts resync, blocks on storage read
    await new Promise((r) => setTimeout(r, 1));
    pubSub.triggerGap(topic); // G2: arrives during the in-flight resync
    await new Promise((r) => setTimeout(r, 1));

    release(); // let the first read complete
    await new Promise((r) => setTimeout(r, 1));

    // The trailing gap must not be dropped: a second resync (fresh storage read) runs.
    expect(storage.fullStateReads).toBe(2);

    await session[Symbol.asyncDispose]();
    await pubSub[Symbol.asyncDispose]();
  });

  it("outbound heal: republishes full state after a publish failure during resync", async () => {
    const storage = new StubStorage(yUpdate("healed"));
    const pubSub = new ControllablePubSub();
    const session = makeSession(storage, pubSub);
    const client = new MockClient<ServerContext>("client-1");
    await session.load();
    session.addClient(client as any);

    // The node's own publish lane fails (its cross-node link dropped) while a client edits;
    // storage still succeeds. Remote nodes never saw a gap on their side.
    pubSub.failPublishes = true;
    const update = new DocMessage(
      "test-doc",
      { type: "update", update: { version: 2, data: yUpdate("edit") as unknown as Update } },
      { clientId: "client-1", userId: "u", room: "r" },
    );
    await session.apply(update as any, client as any).catch(() => {
      // the update publish rejects (expected) — the failure flag is what matters
    });

    // Link restored; the resync now also republishes full state to the document topic so remote
    // nodes heal via the idempotent replication path.
    pubSub.failPublishes = false;
    await session.resyncLocalClientsFromStorage();

    const outbound = pubSub.published.filter((p) => p.topic === topic && p.sourceId === "node-1");
    expect(outbound.length).toBeGreaterThanOrEqual(1);

    await session[Symbol.asyncDispose]();
    await pubSub[Symbol.asyncDispose]();
  });
});
