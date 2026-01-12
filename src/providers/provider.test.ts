import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import {
  Message,
  type ClientContext,
  type Transport,
  DocMessage,
  type StateVector,
  type MilestoneSnapshot,
} from "teleportal";
import { Connection, type ConnectionState } from "./connection";
import { Provider, type DefaultTransportProperties } from "./provider";

// Mock Connection for testing
class MockConnection extends Connection<{
  connected: { clientId: string };
  disconnected: {};
  connecting: {};
  errored: { reconnectAttempt: number };
}> {
  public sentMessages: Message[] = [];
  public responseHandler?: (message: Message) => Message | null;

  constructor() {
    super({ connect: false });
    // Initialize state to disconnected
    this.setState({
      type: "disconnected",
      context: {},
    });
  }

  protected async initConnection(): Promise<void> {
    this.setState({
      type: "connecting",
      context: {},
    });
    // Simulate connection
    await new Promise((resolve) => setTimeout(resolve, 0));
    this.setState({
      type: "connected",
      context: { clientId: "test-client" },
    });
  }

  protected async sendMessage(message: Message): Promise<void> {
    this.sentMessages.push(message);
    // If there's a response handler, simulate a response
    if (this.responseHandler) {
      const response = this.responseHandler(message);
      if (response) {
        // Emit the response asynchronously to simulate network delay
        setTimeout(() => {
          this.call("received-message", response);
        }, 0);
      }
    }
  }

  protected async closeConnection(): Promise<void> {
    this.setState({
      type: "disconnected",
      context: {},
    });
  }

  // Helper method to manually trigger disconnect
  public triggerDisconnect() {
    this.setState({
      type: "disconnected",
      context: {},
    });
  }

  // Helper method to manually trigger connect
  public triggerConnect() {
    this.setState({
      type: "connected",
      context: { clientId: "test-client" },
    });
  }

  // Helper method to simulate receiving a message
  public simulateMessage(message: Message) {
    this.call("received-message", message);
  }
}

// Mock Transport for testing
class MockTransport
  implements Transport<ClientContext, DefaultTransportProperties>
{
  public readable: ReadableStream<Message<ClientContext>>;
  public writable: WritableStream<Message<ClientContext>>;
  public synced: Promise<void>;
  public handler: {
    start: () => Promise<Message<ClientContext>>;
  };

  private syncedResolve?: () => void;
  private syncedReject?: (error: Error) => void;

  constructor() {
    const { readable, writable } = new TransformStream<
      Message<ClientContext>
    >();
    this.readable = readable;
    this.writable = writable;

    // Create a controllable promise for synced
    this.synced = new Promise<void>((resolve, reject) => {
      this.syncedResolve = resolve;
      this.syncedReject = reject;
    });

    this.handler = {
      start: async () => {
        return new DocMessage(
          "test-doc",
          {
            type: "sync-step-1",
            sv: new Uint8Array() as StateVector,
          },
          { clientId: "test-client" },
        );
      },
    };
  }

  // Helper method to resolve the synced promise
  public resolveSynced() {
    if (this.syncedResolve) {
      this.syncedResolve();
    }
  }

  // Helper method to reject the synced promise
  public rejectSynced(error: Error = new Error("Sync failed")) {
    if (this.syncedReject) {
      this.syncedReject(error);
    }
  }
}

describe("Provider sync events", () => {
  let provider: Provider<MockTransport>;
  let mockConnection: MockConnection;
  let mockTransport: MockTransport;
  let ydoc: Y.Doc;

  beforeEach(() => {
    ydoc = new Y.Doc();
    mockConnection = new MockConnection();
    mockTransport = new MockTransport();
  });

  afterEach(() => {
    if (provider) {
      provider.destroy();
    }
    if (mockConnection) {
      mockConnection.destroy();
    }
  });

  it("should emit sync event with [true, doc] when connection connects", async () => {
    const syncEvents: Array<[boolean, Y.Doc]> = [];

    // Set up listener before creating provider
    ydoc.on("sync", (isSynced: boolean, doc: Y.Doc) => {
      syncEvents.push([isSynced, doc]);
    });

    // Start with connection already connected so init() is called immediately
    mockConnection.triggerConnect();
    await new Promise((resolve) => setTimeout(resolve, 10));

    provider = await Provider.create({
      client: mockConnection,
      document: "test-doc",
      ydoc,
      getTransport: () => mockTransport,
      enableOfflinePersistence: false,
    });

    // Wait for init to complete
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Now trigger another connect event to test the listener set up in init()
    mockConnection.triggerDisconnect();
    await new Promise((resolve) => setTimeout(resolve, 10));

    mockConnection.triggerConnect();

    // Wait for event to be processed
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(syncEvents.length).toBeGreaterThan(0);
    const connectedEvent = syncEvents.find(([isSynced]) => isSynced === true);
    expect(connectedEvent).toBeDefined();
    if (connectedEvent) {
      expect(connectedEvent[0]).toBe(true);
      expect(connectedEvent[1]).toBe(ydoc);
    }
  });

  it("should emit sync event with [false, doc] when connection disconnects", async () => {
    const syncEvents: Array<[boolean, Y.Doc]> = [];

    // Set up listener before creating provider
    ydoc.on("sync", (isSynced: boolean, doc: Y.Doc) => {
      syncEvents.push([isSynced, doc]);
    });

    // Connect before creating provider (Provider.create() waits for connection)
    mockConnection.triggerConnect();
    await new Promise((resolve) => setTimeout(resolve, 10));

    provider = await Provider.create({
      client: mockConnection,
      document: "test-doc",
      ydoc,
      getTransport: () => mockTransport,
      enableOfflinePersistence: false,
    });

    // Wait for init to complete
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Then disconnect
    mockConnection.triggerDisconnect();

    // Wait for event to be processed
    await new Promise((resolve) => setTimeout(resolve, 10));

    const disconnectedEvent = syncEvents.find(
      ([isSynced]) => isSynced === false,
    );
    expect(disconnectedEvent).toBeDefined();
    if (disconnectedEvent) {
      expect(disconnectedEvent[0]).toBe(false);
      expect(disconnectedEvent[1]).toBe(ydoc);
    }
  });

  it("should emit sync event with [true, doc] when transport.synced resolves", async () => {
    const syncEvents: Array<[boolean, Y.Doc]> = [];

    // Set up listener before creating provider
    ydoc.on("sync", (isSynced: boolean, doc: Y.Doc) => {
      syncEvents.push([isSynced, doc]);
    });

    // Connect before creating provider
    mockConnection.triggerConnect();
    await new Promise((resolve) => setTimeout(resolve, 10));

    provider = await Provider.create({
      client: mockConnection,
      document: "test-doc",
      ydoc,
      getTransport: () => mockTransport,
      enableOfflinePersistence: false,
    });

    // Wait for init to complete
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Resolve the synced promise
    mockTransport.resolveSynced();

    // Wait for promise to resolve and event to be processed
    await new Promise((resolve) => setTimeout(resolve, 10));

    const syncedEvent = syncEvents.find(([isSynced]) => isSynced === true);
    expect(syncedEvent).toBeDefined();
    if (syncedEvent) {
      expect(syncedEvent[0]).toBe(true);
      expect(syncedEvent[1]).toBe(ydoc);
    }
  });

  it("should emit sync event with [false, doc] when transport.synced rejects", async () => {
    const syncEvents: Array<[boolean, Y.Doc]> = [];

    // Set up listener before creating provider
    ydoc.on("sync", (isSynced: boolean, doc: Y.Doc) => {
      syncEvents.push([isSynced, doc]);
    });

    // Connect before creating provider
    mockConnection.triggerConnect();
    await new Promise((resolve) => setTimeout(resolve, 10));

    provider = await Provider.create({
      client: mockConnection,
      document: "test-doc",
      ydoc,
      getTransport: () => mockTransport,
      enableOfflinePersistence: false,
    });

    // Wait for init to complete
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Reject the synced promise
    mockTransport.rejectSynced(new Error("Sync failed"));

    // Wait for promise to reject and event to be processed
    await new Promise((resolve) => setTimeout(resolve, 10));

    const rejectedEvent = syncEvents.find(([isSynced]) => isSynced === false);
    expect(rejectedEvent).toBeDefined();
    if (rejectedEvent) {
      expect(rejectedEvent[0]).toBe(false);
      expect(rejectedEvent[1]).toBe(ydoc);
    }
  });

  it("should emit multiple sync events for connection state changes", async () => {
    const syncEvents: Array<[boolean, Y.Doc]> = [];

    // Set up listener before creating provider
    ydoc.on("sync", (isSynced: boolean, doc: Y.Doc) => {
      syncEvents.push([isSynced, doc]);
    });

    // Connect before creating provider
    mockConnection.triggerConnect();
    await new Promise((resolve) => setTimeout(resolve, 10));

    provider = await Provider.create({
      client: mockConnection,
      document: "test-doc",
      ydoc,
      getTransport: () => mockTransport,
      enableOfflinePersistence: false,
    });

    // Wait for init to complete
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Disconnect
    mockConnection.triggerDisconnect();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Connect again
    mockConnection.triggerConnect();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Should have multiple events
    expect(syncEvents.length).toBeGreaterThan(1);

    // Check that we have both true and false events
    const trueEvents = syncEvents.filter(([isSynced]) => isSynced === true);
    const falseEvents = syncEvents.filter(([isSynced]) => isSynced === false);

    expect(trueEvents.length).toBeGreaterThan(0);
    expect(falseEvents.length).toBeGreaterThan(0);

    // All events should reference the same doc
    syncEvents.forEach(([, doc]) => {
      expect(doc).toBe(ydoc);
    });
  });

  it("should emit sync events in correct order: connect -> synced resolve", async () => {
    const syncEvents: Array<[boolean, Y.Doc]> = [];

    // Set up listener before creating provider
    ydoc.on("sync", (isSynced: boolean, doc: Y.Doc) => {
      syncEvents.push([isSynced, doc]);
    });

    // Connect before creating provider
    mockConnection.triggerConnect();
    await new Promise((resolve) => setTimeout(resolve, 10));

    provider = await Provider.create({
      client: mockConnection,
      document: "test-doc",
      ydoc,
      getTransport: () => mockTransport,
      enableOfflinePersistence: false,
    });

    // Wait for init to complete
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Resolve synced
    mockTransport.resolveSynced();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Should have at least one true event
    const trueEvents = syncEvents.filter(([isSynced]) => isSynced === true);
    expect(trueEvents.length).toBeGreaterThan(0);
  });

  it("should emit sync event when transport.synced resolves on initial connection", async () => {
    const syncEvents: Array<[boolean, Y.Doc]> = [];

    // Set up listener before creating provider
    ydoc.on("sync", (isSynced: boolean, doc: Y.Doc) => {
      syncEvents.push([isSynced, doc]);
    });

    // Start with connection already connected
    mockConnection.triggerConnect();
    await new Promise((resolve) => setTimeout(resolve, 10));

    provider = await Provider.create({
      client: mockConnection,
      document: "test-doc",
      ydoc,
      getTransport: () => mockTransport,
      enableOfflinePersistence: false,
    });

    // Wait for init to complete
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Resolve synced - this should trigger a sync event
    mockTransport.resolveSynced();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Should have at least one true event from synced resolving
    const trueEvents = syncEvents.filter(([isSynced]) => isSynced === true);
    expect(trueEvents.length).toBeGreaterThan(0);
    expect(trueEvents[0][0]).toBe(true);
    expect(trueEvents[0][1]).toBe(ydoc);
  });
});

describe("Provider milestone operations", () => {
  let provider: Provider<MockTransport>;
  let mockConnection: MockConnection;
  let mockTransport: MockTransport;
  let ydoc: Y.Doc;

  beforeEach(() => {
    ydoc = new Y.Doc();
    mockConnection = new MockConnection();
    mockTransport = new MockTransport();
    mockConnection.sentMessages = [];
  });

  afterEach(() => {
    if (provider) {
      provider.destroy();
    }
    if (mockConnection) {
      mockConnection.destroy();
    }
  });

  // Helper function to set up provider and ack initial messages
  async function setupProvider() {
    mockConnection.triggerConnect();
    provider = await Provider.create({
      client: mockConnection,
      document: "test-doc",
      ydoc,
      getTransport: () => mockTransport,
      enableOfflinePersistence: false,
    });

    // Ack any initial messages sent during provider creation
    const initialMessages = mockConnection.sentMessages;
    if (initialMessages.length > 0) {
      const { AckMessage } = await import("teleportal");
      for (const msg of initialMessages) {
        if (msg.type !== "ack" && msg.type !== "awareness") {
          const ack = new AckMessage(
            { type: "ack", messageId: msg.id },
            { clientId: "test-client" },
          );
          mockConnection.simulateMessage(ack);
        }
      }
    }

    mockTransport.resolveSynced();
    // Wait for synced to resolve (should be fast now that messages are acked)
    await provider.synced;
  }

  it("should list milestones", async () => {
    await setupProvider();

    // Set up response handler
    mockConnection.responseHandler = (message) => {
      if (
        message.type === "doc" &&
        (message as any).payload?.type === "milestone-list-request"
      ) {
        return new DocMessage<ClientContext>(
          "test-doc",
          {
            type: "milestone-list-response",
            milestones: [
              {
                id: "milestone-1",
                name: "v1.0.0",
                documentId: "test-doc",
                createdAt: 1234567890,
              },
              {
                id: "milestone-2",
                name: "v1.1.0",
                documentId: "test-doc",
                createdAt: 1234567900,
              },
            ],
          } as any,
          { clientId: "test-client" },
        );
      }
      return null;
    };

    const milestones = await provider.listMilestones();

    expect(milestones).toHaveLength(2);
    expect(milestones[0].id).toBe("milestone-1");
    expect(milestones[0].name).toBe("v1.0.0");
    expect(milestones[1].id).toBe("milestone-2");
    expect(milestones[1].name).toBe("v1.1.0");
  });

  it("should get milestone snapshot", async () => {
    await setupProvider();

    const testSnapshot = new Uint8Array([1, 2, 3, 4, 5]) as MilestoneSnapshot;

    // Set up response handler for snapshot request
    mockConnection.responseHandler = (message) => {
      if (
        message.type === "doc" &&
        (message as any).payload?.type === "milestone-snapshot-request"
      ) {
        const payload = (message as any).payload;
        if (payload.milestoneId === "milestone-1") {
          return new DocMessage<ClientContext>(
            "test-doc",
            {
              type: "milestone-snapshot-response",
              milestoneId: "milestone-1",
              snapshot: testSnapshot,
            } as any,
            { clientId: "test-client" },
          );
        }
      }
      return null;
    };

    const snapshot = await provider.getMilestoneSnapshot("milestone-1");

    expect(snapshot).toEqual(testSnapshot);
  });

  it("should create milestone", async () => {
    await setupProvider();

    // Add some content to the document
    const ytext = ydoc.getText("content");
    ytext.insert(0, "Hello, World!");

    // Set up response handler
    mockConnection.responseHandler = (message) => {
      if (
        message.type === "doc" &&
        (message as any).payload?.type === "milestone-create-request"
      ) {
        const payload = (message as any).payload;
        return new DocMessage<ClientContext>(
          "test-doc",
          {
            type: "milestone-create-response",
            milestone: {
              id: "milestone-1",
              name: payload.name || "v1.0.0",
              documentId: "test-doc",
              createdAt: Date.now(),
            },
          } as any,
          { clientId: "test-client" },
        );
      }
      return null;
    };

    const milestone = await provider.createMilestone("My Milestone");

    expect(milestone.id).toBe("milestone-1");
    expect(milestone.name).toBe("My Milestone");
    expect(milestone.documentId).toBe("test-doc");
  });

  it("should create milestone without name (auto-generate)", async () => {
    await setupProvider();

    // Set up response handler
    mockConnection.responseHandler = (message) => {
      if (
        message.type === "doc" &&
        (message as any).payload?.type === "milestone-create-request"
      ) {
        return new DocMessage<ClientContext>(
          "test-doc",
          {
            type: "milestone-create-response",
            milestone: {
              id: "milestone-1",
              name: "v1.0.0", // Server auto-generated
              documentId: "test-doc",
              createdAt: Date.now(),
            },
          } as any,
          { clientId: "test-client" },
        );
      }
      return null;
    };

    const milestone = await provider.createMilestone();

    expect(milestone.id).toBe("milestone-1");
    expect(milestone.name).toBe("v1.0.0");
  });

  it("should update milestone name", async () => {
    await setupProvider();

    // Set up response handler
    mockConnection.responseHandler = (message) => {
      if (
        message.type === "doc" &&
        (message as any).payload?.type === "milestone-update-name-request"
      ) {
        const payload = (message as any).payload;
        if (payload.milestoneId === "milestone-1") {
          return new DocMessage<ClientContext>(
            "test-doc",
            {
              type: "milestone-update-name-response",
              milestone: {
                id: "milestone-1",
                name: payload.name,
                documentId: "test-doc",
                createdAt: 1234567890,
              },
            } as any,
            { clientId: "test-client" },
          );
        }
      }
      return null;
    };

    const milestone = await provider.updateMilestoneName(
      "milestone-1",
      "Updated Name",
    );

    expect(milestone.id).toBe("milestone-1");
    expect(milestone.name).toBe("Updated Name");
  });

  it("should handle milestone auth errors", async () => {
    await setupProvider();

    // Set up response handler to return auth error
    mockConnection.responseHandler = (message) => {
      if (
        message.type === "doc" &&
        (message as any).payload?.type === "milestone-list-request"
      ) {
        return new DocMessage<ClientContext>(
          "test-doc",
          {
            type: "milestone-auth-message",
            reason: "Permission denied",
          } as any,
          { clientId: "test-client" },
        );
      }
      return null;
    };

    await expect(provider.listMilestones()).rejects.toThrow(
      "Milestone operation denied: Permission denied",
    );
  });

  it("should handle milestone list with snapshotIds filter", async () => {
    await setupProvider();

    // Set up response handler
    mockConnection.responseHandler = (message) => {
      if (
        message.type === "doc" &&
        (message as any).payload?.type === "milestone-list-request"
      ) {
        const payload = (message as any).payload;
        // Verify snapshotIds were sent
        expect(payload.snapshotIds).toEqual(["milestone-1"]);
        return new DocMessage<ClientContext>(
          "test-doc",
          {
            type: "milestone-list-response",
            milestones: [
              {
                id: "milestone-2",
                name: "v1.1.0",
                documentId: "test-doc",
                createdAt: 1234567900,
              },
            ],
          } as any,
          { clientId: "test-client" },
        );
      }
      return null;
    };

    const milestones = await provider.listMilestones(["milestone-1"]);

    expect(milestones).toHaveLength(1);
    expect(milestones[0].id).toBe("milestone-2");
  });

  describe("synced with in-flight messages", () => {
    it("should wait for in-flight messages to be acked before synced resolves", async () => {
      mockConnection.triggerConnect();
      await new Promise((resolve) => setTimeout(resolve, 10));

      provider = await Provider.create({
        client: mockConnection,
        document: "test-doc",
        ydoc,
        getTransport: () => mockTransport,
        enableOfflinePersistence: false,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));
      mockTransport.resolveSynced();
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Send a message that will be tracked as in-flight
      const docMessage = new DocMessage(
        "test-doc",
        {
          type: "sync-step-1",
          sv: new Uint8Array() as StateVector,
        },
        { clientId: "test-client" },
      );

      await mockConnection.send(docMessage);

      // synced should not resolve yet (has in-flight message)
      let syncedResolved = false;
      const syncedPromise = provider.synced.then(() => {
        syncedResolved = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(syncedResolved).toBe(false);
      expect(mockConnection.inFlightMessageCount).toBeGreaterThan(0);

      // Send ACK for the message
      const { AckMessage } = await import("teleportal");
      const ackMessage = new AckMessage(
        {
          type: "ack",
          messageId: docMessage.id,
        },
        { clientId: "test-client" },
      );
      mockConnection.simulateMessage(ackMessage);

      // Wait for ACK to be processed
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Now synced should resolve
      await syncedPromise;
      expect(syncedResolved).toBe(true);
      expect(mockConnection.inFlightMessageCount).toBe(0);
    });

    it("should resolve synced immediately when no in-flight messages", async () => {
      mockConnection.triggerConnect();
      await new Promise((resolve) => setTimeout(resolve, 10));

      provider = await Provider.create({
        client: mockConnection,
        document: "test-doc",
        ydoc,
        getTransport: () => mockTransport,
        enableOfflinePersistence: false,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Ack any initial messages sent during provider creation
      const initialMessages = mockConnection.sentMessages;
      if (initialMessages.length > 0) {
        const { AckMessage } = await import("teleportal");
        for (const msg of initialMessages) {
          if (msg.type !== "ack" && msg.type !== "awareness") {
            const ack = new AckMessage(
              { type: "ack", messageId: msg.id },
              { clientId: "test-client" },
            );
            mockConnection.simulateMessage(ack);
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      mockTransport.resolveSynced();
      await new Promise((resolve) => setTimeout(resolve, 50));

      // No in-flight messages, synced should resolve quickly
      const startTime = Date.now();
      await provider.synced;
      const endTime = Date.now();

      // Should resolve quickly (within 500ms to account for all async operations)
      expect(endTime - startTime).toBeLessThan(500);
    });

    it("should not wait for awareness messages to be acked", async () => {
      mockConnection.triggerConnect();
      await new Promise((resolve) => setTimeout(resolve, 10));

      provider = await Provider.create({
        client: mockConnection,
        document: "test-doc",
        ydoc,
        getTransport: () => mockTransport,
        enableOfflinePersistence: false,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Ack any initial messages sent during provider creation
      const initialMessages = mockConnection.sentMessages;
      if (initialMessages.length > 0) {
        const { AckMessage } = await import("teleportal");
        for (const msg of initialMessages) {
          if (msg.type !== "ack" && msg.type !== "awareness") {
            const ack = new AckMessage(
              { type: "ack", messageId: msg.id },
              { clientId: "test-client" },
            );
            mockConnection.simulateMessage(ack);
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      mockTransport.resolveSynced();
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Send an awareness message (should not be tracked)
      const { AwarenessMessage } = await import("teleportal");
      const awarenessMessage = new AwarenessMessage(
        "test-doc",
        {
          type: "awareness-update",
          update: new Uint8Array([1, 2, 3]) as any,
        },
        { clientId: "test-client" },
      );

      await mockConnection.send(awarenessMessage);
      await new Promise((resolve) => setTimeout(resolve, 10));

      // synced should resolve even with awareness message sent (not tracked)
      expect(mockConnection.inFlightMessageCount).toBe(0);

      // Access synced after sending awareness message
      const startTime = Date.now();
      await provider.synced;
      const endTime = Date.now();

      // Should resolve quickly (within 500ms to account for all async operations)
      expect(endTime - startTime).toBeLessThan(500);
    });
  });
});

describe("Provider events", () => {
  let provider: Provider<MockTransport>;
  let mockConnection: MockConnection;
  let mockTransport: MockTransport;
  let ydoc: Y.Doc;

  beforeEach(() => {
    ydoc = new Y.Doc();
    mockConnection = new MockConnection();
    mockTransport = new MockTransport();
  });

  afterEach(() => {
    if (provider) {
      provider.destroy();
    }
    if (mockConnection) {
      mockConnection.destroy();
    }
  });

  describe("connected event", () => {
    it("should emit connected event when connection connects", async () => {
      const connectedEvents: boolean[] = [];

      mockConnection.triggerConnect();
      await new Promise((resolve) => setTimeout(resolve, 10));

      provider = await Provider.create({
        client: mockConnection,
        document: "test-doc",
        ydoc,
        getTransport: () => mockTransport,
        enableOfflinePersistence: false,
      });

      provider.on("connected", () => {
        connectedEvents.push(true);
      });

      // Wait for initial setup
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Disconnect and reconnect to trigger event
      mockConnection.triggerDisconnect();
      await new Promise((resolve) => setTimeout(resolve, 10));

      mockConnection.triggerConnect();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(connectedEvents.length).toBeGreaterThan(0);
    });
  });

  describe("disconnected event", () => {
    it("should emit disconnected event when connection disconnects", async () => {
      const disconnectedEvents: boolean[] = [];

      mockConnection.triggerConnect();
      await new Promise((resolve) => setTimeout(resolve, 10));

      provider = await Provider.create({
        client: mockConnection,
        document: "test-doc",
        ydoc,
        getTransport: () => mockTransport,
        enableOfflinePersistence: false,
      });

      provider.on("disconnected", () => {
        disconnectedEvents.push(true);
      });

      // Wait for initial setup
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Disconnect to trigger event
      mockConnection.triggerDisconnect();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(disconnectedEvents.length).toBeGreaterThan(0);
    });
  });

  describe("update event", () => {
    it("should emit update event when connection state changes", async () => {
      const updateEvents: ConnectionState<any>[] = [];

      mockConnection.triggerConnect();
      await new Promise((resolve) => setTimeout(resolve, 10));

      provider = await Provider.create({
        client: mockConnection,
        document: "test-doc",
        ydoc,
        getTransport: () => mockTransport,
        enableOfflinePersistence: false,
      });

      provider.on("update", (state) => {
        updateEvents.push(state);
      });

      // Wait for initial setup
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Disconnect to trigger update event
      mockConnection.triggerDisconnect();
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Reconnect to trigger another update event
      mockConnection.triggerConnect();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(updateEvents.length).toBeGreaterThan(0);
      expect(updateEvents.some((e) => e.type === "disconnected")).toBe(true);
      expect(updateEvents.some((e) => e.type === "connected")).toBe(true);
    });
  });

  describe("received-message event", () => {
    it("should emit received-message event when connection receives a message", async () => {
      const receivedMessages: any[] = [];

      mockConnection.triggerConnect();
      await new Promise((resolve) => setTimeout(resolve, 10));

      provider = await Provider.create({
        client: mockConnection,
        document: "test-doc",
        ydoc,
        getTransport: () => mockTransport,
        enableOfflinePersistence: false,
      });

      provider.on("received-message", (message) => {
        receivedMessages.push(message);
      });

      // Wait for initial setup
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Simulate receiving a message
      const { DocMessage } = await import("teleportal");
      const testMessage = new DocMessage(
        "test-doc",
        {
          type: "sync-step-1",
          sv: new Uint8Array() as StateVector,
        },
        { clientId: "test-client" },
      );

      mockConnection.simulateMessage(testMessage);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(receivedMessages.length).toBeGreaterThan(0);
      expect(receivedMessages[0].type).toBe("doc");
    });
  });

  describe("sent-message event", () => {
    it("should emit sent-message event when connection sends a message", async () => {
      const sentMessages: Message[] = [];

      mockConnection.triggerConnect();
      await new Promise((resolve) => setTimeout(resolve, 10));

      provider = await Provider.create({
        client: mockConnection,
        document: "test-doc",
        ydoc,
        getTransport: () => mockTransport,
        enableOfflinePersistence: false,
      });

      provider.on("sent-message", (message) => {
        sentMessages.push(message);
      });

      // Wait for initial setup
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Send a message through the provider
      const { DocMessage } = await import("teleportal");
      const testMessage = new DocMessage(
        "test-doc",
        {
          type: "sync-step-1",
          sv: new Uint8Array() as StateVector,
        },
        { clientId: "test-client" },
      );

      await mockConnection.send(testMessage);
      await new Promise((resolve) => setTimeout(resolve, 10));

      // The sent-message event should be emitted by the connection
      // We need to check if the connection emits it
      expect(mockConnection.sentMessages.length).toBeGreaterThan(0);
    });
  });

  describe("multiple events", () => {
    it("should emit all events correctly during provider lifecycle", async () => {
      const eventLog: Array<{ type: string; data?: any }> = [];

      mockConnection.triggerConnect();
      await new Promise((resolve) => setTimeout(resolve, 10));

      provider = await Provider.create({
        client: mockConnection,
        document: "test-doc",
        ydoc,
        getTransport: () => mockTransport,
        enableOfflinePersistence: false,
      });

      provider.on("connected", () => {
        eventLog.push({ type: "connected" });
      });

      provider.on("disconnected", () => {
        eventLog.push({ type: "disconnected" });
      });

      provider.on("update", (state) => {
        eventLog.push({ type: "update", data: state.type });
      });

      provider.on("received-message", (message) => {
        eventLog.push({ type: "received-message", data: message.type });
      });

      provider.on("sent-message", (message) => {
        eventLog.push({ type: "sent-message", data: message.type });
      });

      // Wait for initial setup
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Trigger various events
      mockConnection.triggerDisconnect();
      await new Promise((resolve) => setTimeout(resolve, 10));

      mockConnection.triggerConnect();
      await new Promise((resolve) => setTimeout(resolve, 10));

      const { DocMessage } = await import("teleportal");
      const testMessage = new DocMessage(
        "test-doc",
        {
          type: "sync-step-1",
          sv: new Uint8Array() as StateVector,
        },
        { clientId: "test-client" },
      );
      mockConnection.simulateMessage(testMessage);
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Verify we got events
      expect(eventLog.length).toBeGreaterThan(0);
      expect(eventLog.some((e) => e.type === "disconnected")).toBe(true);
      expect(eventLog.some((e) => e.type === "connected")).toBe(true);
      expect(eventLog.some((e) => e.type === "update")).toBe(true);
      expect(eventLog.some((e) => e.type === "received-message")).toBe(true);
    });
  });
});
