import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as Y from "yjs";
import { InMemoryPubSub } from "teleportal";
import type { Update, ServerContext } from "teleportal";
import type { MilestoneTrigger } from "teleportal/storage";
import { getMilestoneRpcHandlers } from "./index";
import { Session } from "../../server/session";
import { Server } from "../../server/server";
import { InMemoryMilestoneStorage } from "../../storage/in-memory/milestone-storage";
import { YDocStorage } from "../../storage/in-memory/ydoc";

/**
 * Creates a valid Y.js update from a simple text content
 */
function createYjsUpdate(text: string = "initial"): Update {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, text);
  return Y.encodeStateAsUpdateV2(doc) as Update;
}

describe("Automatic Milestones via Handler Factory", () => {
  let session: Session<ServerContext>;
  let storage: YDocStorage;
  let milestoneStorage: InMemoryMilestoneStorage;
  let pubSub: InMemoryPubSub;
  let server: Server<ServerContext>;

  beforeEach(() => {
    // Clear static maps to ensure test isolation
    YDocStorage.docs.clear();
    YDocStorage.metadata.clear();

    storage = new YDocStorage();
    milestoneStorage = new InMemoryMilestoneStorage();
    pubSub = new InMemoryPubSub();
  });

  afterEach(async () => {
    if (session) await session[Symbol.asyncDispose]();
    if (server) await server[Symbol.asyncDispose]();
    await pubSub[Symbol.asyncDispose]();
  });

  it("should create milestone based on update-count trigger via factory", async () => {
    const trigger: MilestoneTrigger = {
      id: "trigger-1",
      enabled: true,
      type: "update-count",
      config: { updateCount: 2 },
      autoName: "Auto Milestone",
    };

    const handlers = getMilestoneRpcHandlers(milestoneStorage, {
      triggers: [trigger],
    });

    await storage.writeDocumentMetadata("test-doc", {
      createdAt: Date.now(),
      updatedAt: Date.now(),
      encrypted: false,
      milestoneTriggers: [trigger],
    });

    server = new Server<ServerContext>({
      storage: async () => storage,
      pubSub,
      rpcHandlers: handlers,
    });

    session = await server.getOrOpenSession("test-doc", {
      encrypted: false,
      context: {} as ServerContext,
    });

    await session.write(createYjsUpdate("update 1"));

    let milestones = await milestoneStorage.getMilestones("test-doc");
    expect(milestones.length).toBe(0);

    await session.write(createYjsUpdate("update 2"));

    // Wait for async milestone creation (createAutomaticMilestone is fire-and-forget)
    await new Promise((resolve) => setTimeout(resolve, 10));

    milestones = await milestoneStorage.getMilestones("test-doc");
    expect(milestones.length).toBe(1);
    expect(milestones[0].name).toBe("Auto Milestone");

    await session.write(createYjsUpdate("update 3"));
    milestones = await milestoneStorage.getMilestones("test-doc");
    expect(milestones.length).toBe(1);
  });

  it("should create milestone based on time-based trigger via factory", async () => {
    const trigger: MilestoneTrigger = {
      id: "trigger-time",
      enabled: true,
      type: "time-based",
      config: { interval: 100 },
      autoName: "Time Milestone",
    };

    const handlers = getMilestoneRpcHandlers(milestoneStorage, {
      triggers: [trigger],
    });

    await storage.writeDocumentMetadata("test-doc", {
      createdAt: Date.now(),
      updatedAt: Date.now(),
      encrypted: false,
      milestoneTriggers: [trigger],
    });

    server = new Server<ServerContext>({
      storage: async () => storage,
      pubSub,
      rpcHandlers: handlers,
    });

    session = await server.getOrOpenSession("test-doc", {
      encrypted: false,
      context: {} as ServerContext,
    });

    await session.write(createYjsUpdate("time update 1"));
    let milestones = await milestoneStorage.getMilestones("test-doc");
    expect(milestones.length).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 150));

    await session.write(createYjsUpdate("time update 2"));
    milestones = await milestoneStorage.getMilestones("test-doc");
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

    const handlers = getMilestoneRpcHandlers(milestoneStorage, {
      triggers: [trigger],
    });

    await storage.writeDocumentMetadata("test-doc", {
      createdAt: Date.now(),
      updatedAt: Date.now(),
      encrypted: false,
      milestoneTriggers: [trigger],
    });

    server = new Server<ServerContext>({
      storage: async () => storage,
      pubSub,
      rpcHandlers: handlers,
    });

    session = await server.getOrOpenSession("test-doc", {
      encrypted: false,
      context: {} as ServerContext,
    });

    await session.write(createYjsUpdate("disabled update 1"));
    await session.write(createYjsUpdate("disabled update 2"));

    const milestones = await milestoneStorage.getMilestones("test-doc");
    expect(milestones.length).toBe(0);
  });

  it("should not create milestones when no triggers configured", async () => {
    const handlers = getMilestoneRpcHandlers(milestoneStorage);

    await storage.writeDocumentMetadata("test-doc", {
      createdAt: Date.now(),
      updatedAt: Date.now(),
      encrypted: false,
    });

    server = new Server<ServerContext>({
      storage: async () => storage,
      pubSub,
      rpcHandlers: handlers,
    });

    session = await server.getOrOpenSession("test-doc", {
      encrypted: false,
      context: {} as ServerContext,
    });

    await session.write(createYjsUpdate("no trigger update 1"));
    await session.write(createYjsUpdate("no trigger update 2"));

    const milestones = await milestoneStorage.getMilestones("test-doc");
    expect(milestones.length).toBe(0);
  });

  it("should call onMilestoneCreated callback when milestone is created", async () => {
    let callbackCalled = false;
    let capturedMilestoneId = "";
    let capturedDocumentId = "";

    const trigger: MilestoneTrigger = {
      id: "trigger-callback",
      enabled: true,
      type: "update-count",
      config: { updateCount: 1 },
      autoName: "Callback Milestone",
    };

    const handlers = getMilestoneRpcHandlers(milestoneStorage, {
      triggers: [trigger],
      onMilestoneCreated: (milestoneId, docId) => {
        callbackCalled = true;
        capturedMilestoneId = milestoneId;
        capturedDocumentId = docId;
      },
    });

    await storage.writeDocumentMetadata("test-doc", {
      createdAt: Date.now(),
      updatedAt: Date.now(),
      encrypted: false,
      milestoneTriggers: [trigger],
    });

    server = new Server<ServerContext>({
      storage: async () => storage,
      pubSub,
      rpcHandlers: handlers,
    });

    session = await server.getOrOpenSession("test-doc", {
      encrypted: false,
      context: {} as ServerContext,
    });

    await session.write(createYjsUpdate("callback update"));

    // Wait for async milestone creation to complete (createAutomaticMilestone is fire-and-forget)
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(callbackCalled).toBe(true);
    expect(capturedMilestoneId).toBeTruthy();
    expect(capturedDocumentId).toBe("test-doc");
  });

  it("should update DocumentMetadata when milestone is created", async () => {
    const trigger: MilestoneTrigger = {
      id: "trigger-metadata",
      enabled: true,
      type: "update-count",
      config: { updateCount: 1 },
    };

    const handlers = getMilestoneRpcHandlers(milestoneStorage, {
      triggers: [trigger],
    });

    await storage.writeDocumentMetadata("test-doc", {
      createdAt: Date.now(),
      updatedAt: Date.now(),
      encrypted: false,
      milestones: [],
    });

    server = new Server<ServerContext>({
      storage: async () => storage,
      pubSub,
      rpcHandlers: handlers,
    });

    session = await server.getOrOpenSession("test-doc", {
      encrypted: false,
      context: {} as ServerContext,
    });

    await session.write(createYjsUpdate("metadata update"));

    // Wait for async milestone creation to complete (createAutomaticMilestone is fire-and-forget)
    await new Promise((resolve) => setTimeout(resolve, 10));

    const metadata = await storage.getDocumentMetadata("test-doc");
    expect(metadata.milestones).toBeDefined();
    expect(metadata.milestones!.length).toBe(1);
  });
});
