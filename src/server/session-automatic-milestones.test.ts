import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { DocMessage, InMemoryPubSub } from "teleportal";
import type {
  Update,
  Message,
  ServerContext,
  StateVector,
  SyncStep2Update,
  Milestone,
  MilestoneSnapshot,
} from "teleportal";
import type {
  Document,
  DocumentMetadata,
  DocumentStorage,
  MilestoneStorage,
  MilestoneTrigger,
} from "teleportal/storage";
import { Session } from "./session";
import { Client } from "./client";

// Mock Client class for testing
class MockClient<Context extends ServerContext> {
  public id: string;
  public sentMessages: Message<Context>[] = [];
  public mockSend = false;

  constructor(id: string) {
    this.id = id;
  }

  async send(message: Message<Context>) {
    this.mockSend = true;
    this.sentMessages.push(message);
  }
}

// Mock MilestoneStorage
class MockMilestoneStorage implements MilestoneStorage {
  readonly type = "milestone-storage" as const;
  public milestones: Map<string, Milestone> = new Map();
  public createdCount = 0;

  async createMilestone(ctx: {
    name: string;
    documentId: string;
    createdAt: number;
    snapshot: MilestoneSnapshot;
  }): Promise<string> {
    this.createdCount++;
    const id = `milestone-${Date.now()}-${this.createdCount}`;
    const milestone: Milestone = {
      id,
      name: ctx.name,
      documentId: ctx.documentId,
      createdAt: ctx.createdAt,
      snapshot: ctx.snapshot,
      fetchSnapshot: async () => ctx.snapshot,
      encode: () => new Uint8Array(),
      toJSON: () => ({
        id,
        name: ctx.name,
        documentId: ctx.documentId,
        createdAt: ctx.createdAt,
      }),
      toString: () => `Milestone(${id})`,
      loaded: true,
    } as any; // Cast to any to bypass missing methods/properties
    this.milestones.set(id, milestone);
    return id;
  }

  async getMilestones(documentId: string): Promise<Milestone[]> {
    return [...this.milestones.values()].filter(
      (m) => m.documentId === documentId,
    );
  }

  async getMilestone(
    documentId: string,
    id: string,
  ): Promise<Milestone | null> {
    const m = this.milestones.get(id);
    if (m && m.documentId === documentId) return m;
    return null;
  }

  async deleteMilestone() {}
  async restoreMilestone() {}
  async updateMilestoneName() {}
}

// Mock DocumentStorage
class MockDocumentStorage implements DocumentStorage {
  readonly type = "document-storage" as const;
  storageType: "encrypted" | "unencrypted" = "unencrypted";

  fileStorage = undefined;
  milestoneStorage: MilestoneStorage | undefined = new MockMilestoneStorage();

  public metadata: Map<string, DocumentMetadata> = new Map();
  public storedUpdate: Update | null = null;

  async handleSyncStep1(
    documentId: string,
    syncStep1: StateVector,
  ): Promise<Document> {
    return {
      id: documentId,
      metadata: await this.getDocumentMetadata(documentId),
      content: {
        update: new Uint8Array([1, 2, 3]) as unknown as Update,
        stateVector: syncStep1,
      },
    };
  }

  async handleSyncStep2(
    _key: string,
    syncStep2: SyncStep2Update,
  ): Promise<void> {}

  async handleUpdate(_documentId: string, update: Update): Promise<void> {
    this.storedUpdate = update;
  }

  async getDocument(documentId: string): Promise<Document | null> {
    if (!this.storedUpdate) return null;
    return {
      id: documentId,
      metadata: await this.getDocumentMetadata(documentId),
      content: {
        update: this.storedUpdate,
        stateVector: new Uint8Array() as unknown as StateVector,
      },
    };
  }

  async writeDocumentMetadata(
    documentId: string,
    metadata: DocumentMetadata,
  ): Promise<void> {
    this.metadata.set(documentId, metadata);
  }

  async getDocumentMetadata(documentId: string): Promise<DocumentMetadata> {
    return (
      this.metadata.get(documentId) ?? {
        createdAt: Date.now(),
        updatedAt: Date.now(),
        encrypted: false,
      }
    );
  }

  async deleteDocument() {}
  async transaction<T>(_id: string, cb: () => Promise<T>) {
    return cb();
  }
  async addFileToDocument() {}
  async removeFileFromDocument() {}
}

describe("Session Automatic Milestones", () => {
  let session: Session<ServerContext>;
  let storage: MockDocumentStorage;
  let pubSub: InMemoryPubSub;
  let client1: MockClient<ServerContext>;
  const nodeId = "test-node";

  beforeEach(() => {
    storage = new MockDocumentStorage();
    storage.milestoneStorage = new MockMilestoneStorage();
    storage.storedUpdate = new Uint8Array([1, 2, 3]) as Update; // Ensure document exists
    pubSub = new InMemoryPubSub();
    client1 = new MockClient<ServerContext>("client-1");
  });

  afterEach(async () => {
    if (session) await session[Symbol.asyncDispose]();
    await pubSub[Symbol.asyncDispose]();
  });

  it("should create milestone based on update count trigger", async () => {
    // Set up trigger
    const trigger: MilestoneTrigger = {
      id: "trigger-1",
      enabled: true,
      type: "update-count",
      config: { updateCount: 2 },
      autoName: "Auto Milestone",
    };

    await storage.writeDocumentMetadata("test-doc", {
      createdAt: Date.now(),
      updatedAt: Date.now(),
      encrypted: false,
      milestoneTriggers: [trigger],
    });

    session = new Session({
      documentId: "test-doc",
      namespacedDocumentId: "test-doc",
      id: "session-1",
      encrypted: false,
      storage,
      pubSub,
      nodeId,
      onCleanupScheduled: () => {},
    });

    await session.load();
    session.addClient(client1 as any);

    const update = new Uint8Array([1, 2, 3]) as Update;
    const message = new DocMessage(
      "test-doc",
      { type: "update", update },
      { clientId: "client-1", userId: "user-1", room: "room" },
      false,
    );

    // First update (count = 1)
    await session.write(update);

    let milestones = await storage.milestoneStorage!.getMilestones("test-doc");
    expect(milestones.length).toBe(0);

    // Second update (count = 2) -> Should trigger
    await session.write(update);

    milestones = await storage.milestoneStorage!.getMilestones("test-doc");
    expect(milestones.length).toBe(1);
    expect(milestones[0].name).toBe("Auto Milestone");

    // Third update (count = 1)
    await session.write(update);
    milestones = await storage.milestoneStorage!.getMilestones("test-doc");
    expect(milestones.length).toBe(1);
  });

  it("should create milestone based on time-based trigger in write", async () => {
    // Set up trigger with short interval
    const trigger: MilestoneTrigger = {
      id: "trigger-time",
      enabled: true,
      type: "time-based",
      config: { interval: 100 }, // 100ms
      autoName: "Time Milestone",
    };

    await storage.writeDocumentMetadata("test-doc", {
      createdAt: Date.now(),
      updatedAt: Date.now(),
      encrypted: false,
      milestoneTriggers: [trigger],
    });

    session = new Session({
      documentId: "test-doc",
      namespacedDocumentId: "test-doc",
      id: "session-2",
      encrypted: false,
      storage,
      pubSub,
      nodeId,
      onCleanupScheduled: () => {},
    });

    await session.load();

    const update = new Uint8Array([1, 2, 3]) as Update;

    // First write - should not trigger yet (lastMilestoneTime just initialized)
    await session.write(update);
    let milestones = await storage.milestoneStorage!.getMilestones("test-doc");
    expect(milestones.length).toBe(0);

    // Wait for interval
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Write again - should trigger
    await session.write(update);
    milestones = await storage.milestoneStorage!.getMilestones("test-doc");
    expect(milestones.length).toBe(1);
    expect(milestones[0].name).toBe("Time Milestone");
  });

  it("should respect enabled flag", async () => {
    const trigger: MilestoneTrigger = {
      id: "trigger-disabled",
      enabled: false,
      type: "update-count",
      config: { updateCount: 1 },
    };

    await storage.writeDocumentMetadata("test-doc", {
      createdAt: Date.now(),
      updatedAt: Date.now(),
      encrypted: false,
      milestoneTriggers: [trigger],
    });

    session = new Session({
      documentId: "test-doc",
      namespacedDocumentId: "test-doc",
      id: "session-3",
      encrypted: false,
      storage,
      pubSub,
      nodeId,
      onCleanupScheduled: () => {},
    });

    await session.load();
    const update = new Uint8Array([1, 2, 3]) as Update;

    await session.write(update);
    await session.write(update);

    const milestones =
      await storage.milestoneStorage!.getMilestones("test-doc");
    expect(milestones.length).toBe(0);
  });
});
