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
    this.logger = this.server.logger.child();
    this.logger.clearContext();
    this.logger.withContext({ name: "agent" });
  }

  public async createAgent(
    message: Pick<Message<ServerContext>, "document" | "context" | "encrypted">,
    handler?: YDocSinkHandler & YDocSourceHandler,
  ) {
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

    const client = await this.server.createClient({
      transport,
      id: message.context.clientId,
    });

    logger
      .withContext({
        clientId: client.id,
      })
      .trace("client created");

    logger.trace("getting or creating document");
    await this.server.getOrCreateDocument(message);
    logger.trace("document created");

    await observer.call("message", await transport.handler.start());

    logger.trace("sync started");
    await transport.synced;
    console.log("synced", transport.ydoc.toJSON());
    logger.trace("synced");

    // hand back the ydoc? What interface should we expose?

    return {
      ydoc: transport.ydoc,
      awareness: transport.awareness,
      destroy: async (): Promise<void> => {
        // TODO properly close this?
        await client.destroy();
        transport.ydoc.destroy();
      },
      clientId: client.id,
    };
  }
}
