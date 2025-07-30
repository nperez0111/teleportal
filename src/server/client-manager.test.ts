import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { ClientManager, type ClientManagerOptions } from "./client-manager";
import { Client } from "./client";
import { logger } from "./logger";
import type { ServerContext, Message } from "teleportal";

// Mock Client class for testing
class MockClient<Context extends ServerContext> extends Client<Context> {
  public mockDestroy = false;
  public mockSend = false;

  constructor(id: string, logger: any) {
    const writable = new WritableStream({
      write() {
        // Mock implementation
      },
    });
    super({ id, writable, logger });
  }

  async destroy() {
    this.mockDestroy = true;
    await super.destroy();
  }

  async send(message: Message<Context>) {
    this.mockSend = true;
    await super.send(message);
  }
}

describe("ClientManager", () => {
  let clientManager: ClientManager<ServerContext>;
  let options: ClientManagerOptions;

  beforeEach(() => {
    options = {
      logger: logger.child().withContext({ name: "test" }),
    };
    clientManager = new ClientManager(options);
  });

  afterEach(async () => {
    await clientManager.destroy();
  });

  describe("constructor", () => {
    it("should create a ClientManager instance", () => {
      expect(clientManager).toBeDefined();
      expect(clientManager.getStats().numClients).toBe(0);
    });
  });

  describe("getClient", () => {
    it("should return undefined for non-existent client", () => {
      const client = clientManager.getClient("non-existent");
      expect(client).toBeUndefined();
    });

    it("should return client when it exists", () => {
      const mockClient = new MockClient("test-client", options.logger);
      clientManager.addClient(mockClient);

      const retrievedClient = clientManager.getClient("test-client");
      expect(retrievedClient).toBe(mockClient);
    });
  });

  describe("addClient", () => {
    it("should add a client to the manager", () => {
      const mockClient = new MockClient("test-client", options.logger);

      clientManager.addClient(mockClient);

      expect(clientManager.getClient("test-client")).toBe(mockClient);
      expect(clientManager.getStats().numClients).toBe(1);
      expect(clientManager.getStats().clientIds).toContain("test-client");
    });

    it("should emit client-connected event", async () => {
      const mockClient = new MockClient("test-client", options.logger);
      let eventEmitted = false;
      let emittedClient: Client<ServerContext> | undefined;

      clientManager.on("client-connected", (client: Client<ServerContext>) => {
        eventEmitted = true;
        emittedClient = client;
      });

      clientManager.addClient(mockClient);

      // Wait for event to be processed
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(eventEmitted).toBe(true);
      expect(emittedClient).toBe(mockClient);
    });

    it("should set up destroy listener on client", async () => {
      const mockClient = new MockClient("test-client", options.logger);

      clientManager.addClient(mockClient);
      expect(clientManager.getStats().numClients).toBe(1);

      // Trigger client destroy
      await mockClient.destroy();

      // Wait for the destroy event to be processed
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(clientManager.getStats().numClients).toBe(0);
    });
  });

  describe("removeClient", () => {
    it("should remove existing client", async () => {
      const mockClient = new MockClient("test-client", options.logger);
      clientManager.addClient(mockClient);
      expect(clientManager.getStats().numClients).toBe(1);

      await clientManager.removeClient("test-client");

      expect(clientManager.getClient("test-client")).toBeUndefined();
      expect(clientManager.getStats().numClients).toBe(0);
      expect(mockClient.mockDestroy).toBe(true);
    });

    it("should not throw when removing non-existent client", async () => {
      await expect(
        clientManager.removeClient("non-existent"),
      ).resolves.toBeUndefined();
    });

    it("should emit client-disconnected event", async () => {
      const mockClient = new MockClient("test-client", options.logger);
      clientManager.addClient(mockClient);

      let eventEmitted = false;
      let emittedClient: Client<ServerContext> | undefined;

      clientManager.on(
        "client-disconnected",
        (client: Client<ServerContext>) => {
          eventEmitted = true;
          emittedClient = client;
        },
      );

      await clientManager.removeClient("test-client");

      expect(eventEmitted).toBe(true);
      expect(emittedClient).toBe(mockClient);
    });
  });

  describe("getStats", () => {
    it("should return correct stats for empty manager", () => {
      const stats = clientManager.getStats();
      expect(stats.numClients).toBe(0);
      expect(stats.clientIds).toEqual([]);
    });

    it("should return correct stats with clients", () => {
      const client1 = new MockClient("client-1", options.logger);
      const client2 = new MockClient("client-2", options.logger);

      clientManager.addClient(client1);
      clientManager.addClient(client2);

      const stats = clientManager.getStats();
      expect(stats.numClients).toBe(2);
      expect(stats.clientIds).toContain("client-1");
      expect(stats.clientIds).toContain("client-2");
    });
  });

  describe("destroy", () => {
    it("should destroy all clients and clear the manager", async () => {
      const client1 = new MockClient("client-1", options.logger);
      const client2 = new MockClient("client-2", options.logger);

      clientManager.addClient(client1);
      clientManager.addClient(client2);
      expect(clientManager.getStats().numClients).toBe(2);

      await clientManager.destroy();

      expect(clientManager.getStats().numClients).toBe(0);
      expect(client1.mockDestroy).toBe(true);
      expect(client2.mockDestroy).toBe(true);
    });

    it("should work with empty manager", async () => {
      await expect(clientManager.destroy()).resolves.toBeUndefined();
      expect(clientManager.getStats().numClients).toBe(0);
    });
  });
});
