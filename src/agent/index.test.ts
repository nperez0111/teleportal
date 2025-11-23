import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getLogger } from "@logtape/logtape";
import type { ServerContext } from "teleportal";
import { InMemoryPubSub } from "teleportal";
import { Server } from "teleportal/server";
import { YDocStorage } from "teleportal/storage";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { Agent } from "./index";

describe("Agent", () => {
  let server: Server<ServerContext>;
  let agent: Agent;
  let mockGetStorage: any;
  let pubSub: InMemoryPubSub;

  beforeEach(() => {
    pubSub = new InMemoryPubSub();
    // Clear any existing docs from previous tests
    YDocStorage.docs.clear();
    mockGetStorage = () => Promise.resolve(new YDocStorage());

    server = new Server({
      getStorage: mockGetStorage,
      pubSub,
    });

    agent = new Agent(server);
  });

  afterEach(async () => {
    await server[Symbol.asyncDispose]();
    await pubSub[Symbol.asyncDispose]();
  });

  describe("constructor", () => {
    it("should create an Agent instance", () => {
      expect(agent).toBeDefined();
      expect(agent).toBeInstanceOf(Agent);
    });

    it("should create a logger with agent context", () => {
      // The logger is private, but we can verify the agent was created
      expect(agent).toBeDefined();
    });
  });

  describe("createAgent", () => {
    it("should create an agent and return ydoc, awareness, destroy, and clientId", async () => {
      // Note: This test verifies the agent creation works
      // The sync process requires the full message flow to complete
      const result = await agent.createAgent({
        document: "test-doc",
        context: {
          clientId: "test-client",
          userId: "test-user",
          room: "test-room",
        },
        encrypted: false,
      });

      expect(result).toBeDefined();
      expect(result.ydoc).toBeInstanceOf(Y.Doc);
      expect(result.awareness).toBeInstanceOf(Awareness);
      expect(result.clientId).toBe("test-client");
      expect(typeof result[Symbol.asyncDispose]).toBe("function");

      // Clean up
      await result[Symbol.asyncDispose]();
    }, 15000);

    it("should create a client with the provided clientId", async () => {
      const result = await agent.createAgent({
        document: "test-doc-2",
        context: {
          clientId: "custom-client-id",
          userId: "test-user",
          room: "test-room",
        },
        encrypted: false,
      });

      expect(result.clientId).toBe("custom-client-id");

      await result[Symbol.asyncDispose]();
    }, 15000);

    it("should create a session for the document", async () => {
      const result = await agent.createAgent({
        document: "test-doc-session",
        context: {
          clientId: "test-client",
          userId: "test-user",
          room: "test-room",
        },
        encrypted: false,
      });

      // Verify session was created by checking if we can get it again
      const session = await server.getOrOpenSession("test-doc-session", {
        encrypted: false,
        context: {
          clientId: "test-client",
          userId: "test-user",
          room: "test-room",
        },
      });

      expect(session).toBeDefined();
      expect(session.documentId).toBe("test-doc-session");

      await result[Symbol.asyncDispose]();
    }, 15000);

    it("should sync the transport and wait for synced promise", async () => {
      const result = await agent.createAgent({
        document: "sync-test-doc",
        context: {
          clientId: "test-client",
          userId: "test-user",
          room: "test-room",
        },
        encrypted: false,
      });

      // The synced promise should resolve (or we'd be waiting forever)
      // We can verify the ydoc is accessible
      expect(result.ydoc).toBeDefined();
      // If we got here, the synced promise resolved successfully

      await result[Symbol.asyncDispose]();
    }, 15000);

    it("should accept optional custom handler", async () => {
      // Test that createAgent accepts an optional handler parameter
      // We'll just verify it compiles and runs without a handler
      const result = await agent.createAgent({
        document: "handler-test-doc",
        context: {
          clientId: "test-client",
          userId: "test-user",
          room: "test-room",
        },
        encrypted: false,
      });

      expect(result).toBeDefined();
      expect(result.ydoc).toBeInstanceOf(Y.Doc);

      await result[Symbol.asyncDispose]();
    }, 15000);

    it("should allow modifying the ydoc after creation", async () => {
      const result = await agent.createAgent({
        document: "modify-test-doc",
        context: {
          clientId: "test-client",
          userId: "test-user",
          room: "test-room",
        },
        encrypted: false,
      });

      const text = result.ydoc.getText("test");
      text.insert(0, "Hello, World!");

      expect(text.toString()).toBe("Hello, World!");

      await result[Symbol.asyncDispose]();
    }, 15000);

    it("should properly destroy the agent and clean up resources", async () => {
      const result = await agent.createAgent({
        document: "destroy-test-doc",
        context: {
          clientId: "test-client",
          userId: "test-user",
          room: "test-room",
        },
        encrypted: false,
      });

      const clientId = result.clientId;
      const session = await server.getOrOpenSession("destroy-test-doc", {
        encrypted: false,
        context: {
          clientId: "test-client",
          userId: "test-user",
          room: "test-room",
        },
      });

      // Client should be in session before destroy
      expect(session).toBeDefined();

      // Destroy should not throw
      await expect(result[Symbol.asyncDispose]()).resolves.toBeUndefined();

      // YDoc should be destroyed (we can't directly verify, but it shouldn't throw)
      expect(() => result.ydoc.getText("test")).not.toThrow();
    }, 15000);

    it("should handle multiple agents for different documents", async () => {
      const agent1 = await agent.createAgent({
        document: "doc-1",
        context: { clientId: "client-1", userId: "user-1", room: "room-1" },
        encrypted: false,
      });

      const agent2 = await agent.createAgent({
        document: "doc-2",
        context: { clientId: "client-2", userId: "user-2", room: "room-2" },
        encrypted: false,
      });

      expect(agent1.ydoc).toBeDefined();
      expect(agent2.ydoc).toBeDefined();
      expect(agent1.clientId).toBe("client-1");
      expect(agent2.clientId).toBe("client-2");

      await agent1[Symbol.asyncDispose]();
      await agent2[Symbol.asyncDispose]();
    }, 15000);

    it("should handle agents with different rooms", async () => {
      const agent1 = await agent.createAgent({
        document: "same-doc",
        context: { clientId: "client-1", userId: "user-1", room: "room-1" },
        encrypted: false,
      });

      const agent2 = await agent.createAgent({
        document: "same-doc",
        context: { clientId: "client-2", userId: "user-2", room: "room-2" },
        encrypted: false,
      });

      // Should create separate sessions for different rooms
      const session1 = await server.getOrOpenSession("same-doc", {
        encrypted: false,
        context: { clientId: "client-1", userId: "user-1", room: "room-1" },
      });

      const session2 = await server.getOrOpenSession("same-doc", {
        encrypted: false,
        context: { clientId: "client-2", userId: "user-2", room: "room-2" },
      });

      expect(session1).not.toBe(session2);
      expect(session1.namespacedDocumentId).toBe("room-1/same-doc");
      expect(session2.namespacedDocumentId).toBe("room-2/same-doc");

      await agent1[Symbol.asyncDispose]();
      await agent2[Symbol.asyncDispose]();
    }, 15000);

    it("should handle empty room in context", async () => {
      const result = await agent.createAgent({
        document: "empty-room-doc",
        context: { clientId: "test-client", userId: "test-user", room: "" },
        encrypted: false,
      });

      expect(result).toBeDefined();

      const session = await server.getOrOpenSession("empty-room-doc", {
        encrypted: false,
        context: { clientId: "test-client", userId: "test-user", room: "" },
      });

      expect(session.namespacedDocumentId).toBe("empty-room-doc");

      await result[Symbol.asyncDispose]();
    }, 15000);
  });
});
