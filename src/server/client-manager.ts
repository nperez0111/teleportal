import { Observable, type ServerContext } from "teleportal";
import { Client } from "./client";
import type { Logger } from "./logger";

export type ClientManagerOptions = {
  logger: Logger;
};

/**
 * The ClientManager is responsible for creating, destroying, and managing clients.
 *
 * It holds all open clients in memory, and provides a way to get or create clients.
 */
export class ClientManager<Context extends ServerContext> extends Observable<{
  "client-connected": (client: Client<Context>) => void;
  "client-disconnected": (client: Client<Context>) => void;
}> {
  private clients = new Map<string, Client<Context>>();
  private logger: Logger;

  constructor(options: ClientManagerOptions) {
    super();
    this.logger = options.logger
      .child()
      .withContext({ name: "client-manager" });
  }

  /**
   * Get a client by ID
   */
  public getClient(clientId: string): Client<Context> | undefined {
    return this.clients.get(clientId);
  }

  /**
   * Add a client to the manager
   */
  public addClient(client: Client<Context>): void {
    const clientId = client.id;
    this.clients.set(clientId, client);
    this.logger.withMetadata({ clientId }).trace("client added to manager");

    this.call("client-connected", client);
    client.once("destroy", () => {
      this.removeClient(clientId);
    });
  }

  /**
   * Remove a client from the manager
   */
  public async removeClient(clientId: string): Promise<void> {
    const client = this.clients.get(clientId);
    if (!client) {
      return;
    }

    this.logger
      .withMetadata({ clientId })
      .trace("removing client from manager");

    // Remove client from map first to prevent recursive calls
    this.clients.delete(clientId);

    await this.call("client-disconnected", client);

    await client.destroy();
  }

  /**
   * Get client statistics
   */
  public getStats() {
    return {
      numClients: this.clients.size,
      clientIds: Array.from(this.clients.keys()),
    };
  }

  public async destroy() {
    this.logger.trace("destroying client manager");
    await Promise.all(
      Array.from(this.clients.values()).map((client) =>
        this.removeClient(client.id),
      ),
    );
    this.clients.clear();
    this.logger.trace("client manager destroyed");
    super.destroy();
  }
}
