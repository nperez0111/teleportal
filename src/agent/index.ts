import { Message, Observable, ServerContext } from "teleportal";
import { Server } from "teleportal/server";
import { getLogger } from "@logtape/logtape";
import {
  getYTransportFromYDoc,
  YDocSinkHandler,
  YDocSourceHandler,
} from "teleportal/transports";

export class Agent {
  constructor(private server: Server<ServerContext>) {}

  public async createAgent(
    message: Pick<Message<ServerContext>, "document" | "context" | "encrypted">,
    handler?: YDocSinkHandler & YDocSourceHandler,
  ) {
    if (!message.document) {
      throw new Error("Document is required");
    }
    const logger = getLogger(["teleportal", "agent"]).with({
      name: "agent",
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
      .with({
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
      client,
      session,
      [Symbol.asyncDispose]: async (): Promise<void> => {
        session.removeClient(client);
        transport.ydoc.destroy();
      },
    };
  }
}
