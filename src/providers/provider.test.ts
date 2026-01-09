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
          this.call("message", response);
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
    this.call("message", message);
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

  it("should list milestones", async () => {
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
});
