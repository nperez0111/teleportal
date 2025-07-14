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
    this.logger = options.logger.withContext({ name: "client-manager" });
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
    this.clients.set(client.id, client);
    this.logger
      .withMetadata({ clientId: client.id })
      .trace("client added to manager");

    this.call("client-connected", client);
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

    await this.call("client-disconnected", client);

    await client.destroy();
    this.clients.delete(clientId);
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
