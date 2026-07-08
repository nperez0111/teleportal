import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as Y from "yjs";
import { InMemoryPubSub } from "teleportal";
import type { ServerContext, VersionedUpdate } from "teleportal";
import type { MilestoneTrigger } from "teleportal/storage";
import { encodeContentEncryptedPayload } from "teleportal/protocol/encryption";
import { getMilestoneRpcHandlers } from "./index";
import { Session } from "../../server/session";
import { Server } from "../../server/server";
import { InMemoryMilestoneStorage } from "../../storage/in-memory/milestone-storage";
import { MemoryDocumentStorage } from "../../storage/in-memory/document-storage";

function createYjsUpdate(text: string = "initial"): VersionedUpdate {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, text);
  const v2 = Y.encodeStateAsUpdateV2(doc);
  const payload = encodeContentEncryptedPayload({ structureUpdate: v2, encryptedSidecars: [] });
  return { version: 2, data: payload } as unknown as VersionedUpdate;
}

describe("Automatic Milestones via Handler Factory", () => {
  let session: Session<ServerContext>;
  let storage: MemoryDocumentStorage;
  let milestoneStorage: InMemoryMilestoneStorage;
  let pubSub: InMemoryPubSub;
  let server: Server<ServerContext>;

  beforeEach(() => {
    // Clear static maps to ensure test isolation
    MemoryDocumentStorage.docs.clear();
    MemoryDocumentStorage.pendingUpdates.clear();
    MemoryDocumentStorage.attributionMaps.clear();
    MemoryDocumentStorage.attributionCache.clear();

    storage = new MemoryDocumentStorage();
    milestoneStorage = new InMemoryMilestoneStorage();
    pubSub = new InMemoryPubSub();
  });

  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (server) await server[Symbol.asyncDispose]();
    if (session) await session[Symbol.asyncDispose]();
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
    await new Promise((resolve) => setTimeout(resolve, 1));

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
      config: { interval: 1 },
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

    // Ensure the trigger interval (1ms) has elapsed since the first write set
    // the baseline, so the next write is eligible to fire the trigger.
    await new Promise((resolve) => setTimeout(resolve, 2));

    await session.write(createYjsUpdate("time update 2"));

    // Poll for the fire-and-forget async milestone creation to settle, rather
    // than guessing with a fixed sleep (which raced the async storage write
    // under full-suite load).
    const deadline = Date.now() + 2000;
    do {
      milestones = await milestoneStorage.getMilestones("test-doc");
      if (milestones.length >= 1) break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    } while (Date.now() < deadline);

    expect(milestones.length).toBe(1);
    expect(milestones[0].name).toBe("Time Milestone");
  });

  it("time-based trigger does not create milestones without document writes", async () => {
    // Regression: a time-based trigger must fire on the document-write path
    // only. A background setInterval that also fires on its own double-counts
    // (one milestone from the timer, one from the next write) and keeps
    // creating milestones even when the document is idle.
    const trigger: MilestoneTrigger = {
      id: "trigger-idle",
      enabled: true,
      type: "time-based",
      config: { interval: 1 },
      autoName: "Idle Milestone",
    };

    const handlers = getMilestoneRpcHandlers(milestoneStorage, { triggers: [trigger] });

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

    // A single write establishes the per-document trigger state. The interval
    // is 1ms, so a background timer would fire many times during this wait.
    await session.write(createYjsUpdate("only write"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    // With no further writes, exactly zero milestones should exist: the first
    // write did not meet the interval, and there is no self-firing timer.
    const milestones = await milestoneStorage.getMilestones("test-doc");
    expect(milestones.length).toBe(0);
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
    await new Promise((resolve) => setTimeout(resolve, 1));

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
    await new Promise((resolve) => setTimeout(resolve, 1));

    const metadata = await storage.getDocumentMetadata("test-doc");
    expect(metadata.milestones).toBeDefined();
    expect(metadata.milestones!.length).toBe(1);
  });
});
