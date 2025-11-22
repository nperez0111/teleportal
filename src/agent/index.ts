import { Message, Observable, ServerContext } from "teleportal";
import { Logger, Server } from "teleportal/server";
import {
  getYTransportFromYDoc,
  YDocSinkHandler,
  YDocSourceHandler,
} from "teleportal/transports";

export class Agent {
  private logger: Logger;
    constructor(private server: Server<ServerContext>) {
      this.logger = this.server.logger.child().withContext({ name: "agent" });
    }

  public async createAgent(
    message: Pick<Message<ServerContext>, "document" | "context" | "encrypted">,
    handler?: YDocSinkHandler & YDocSourceHandler,
  ) {
    if (!message.document) {
      throw new Error("Document is required");
    }
    const logger = this.logger.child().withContext({
      document: message.document,
    });
    const observer = new Observable<{
      message: (message: Message) => void;
    }>();
    const transport = getYTransportFromYDoc<ServerContext>({
      document: message.document,
      context: message.context,
      handler,
      observer,
    });
    logger.trace("created transport");

    const client = this.server.createClient({
      transport,
      id: message.context.clientId,
    });

    logger
      .withContext({
        clientId: client.id,
      })
      .trace("client created");

    logger.trace("getting or creating document");
    const session = await this.server.getOrOpenSession(message.document, {
      encrypted: message.encrypted,
      client,
      context: message.context,
    });
    logger.trace("document created");

    await observer.call("message", await transport.handler.start());

    logger.trace("waiting for transport to sync");
    await transport.synced;
    logger.trace("transport synced");

    return {
      ydoc: transport.ydoc,
      awareness: transport.awareness,
      clientId: client.id,
      [Symbol.asyncDispose]: async (): Promise<void> => {
        session.removeClient(client);
        transport.ydoc.destroy();
      },
    };
  }
}
