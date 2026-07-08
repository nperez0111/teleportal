import { Message, Observable, ServerContext } from "teleportal";
import { emitWideEvent, Server } from "teleportal/server";
import { getYTransportFromYDoc, YDocSinkHandler, YDocSourceHandler } from "teleportal/transports";

export class Agent {
  constructor(private server: Server<ServerContext>) {}

  public async createAgent(
    message: Pick<Message<ServerContext>, "document" | "context" | "encrypted">,
    handler?: YDocSinkHandler & YDocSourceHandler,
  ) {
    if (!message.document) {
      throw new Error("Document is required");
    }
    const startTime = Date.now();
    const wideEvent: Record<string, unknown> = {
      event_type: "agent_create",
      timestamp: new Date().toISOString(),
      document_id: message.document,
      client_id: message.context.clientId,
      encrypted: message.encrypted,
    };
    // Resources created before sync completes. If any step after
    // createClient throws, these must be torn down or we leak the client's
    // background consume loop and the transport's Y.Doc.
    let client: ReturnType<Server<ServerContext>["createClient"]> | undefined;
    let transport: ReturnType<typeof getYTransportFromYDoc<ServerContext>> | undefined;
    try {
      const observer = new Observable<{
        message: (message: Message) => void;
      }>();
      transport = getYTransportFromYDoc<ServerContext>({
        document: message.document,
        context: message.context,
        handler,
        observer,
      });

      const boundTransport = transport;
      const boundClient = this.server.createClient({
        transport,
        id: message.context.clientId,
      });
      client = boundClient;

      wideEvent.client_id = boundClient.id;

      const session = await this.server.getOrOpenSession(message.document, {
        encrypted: message.encrypted,
        client: boundClient,
        context: message.context,
      });

      await observer.call("message", await boundTransport.handler.start());

      await boundTransport.synced;

      wideEvent.outcome = "success";
      return {
        ydoc: boundTransport.ydoc,
        awareness: boundTransport.awareness,
        client: boundClient,
        session,
        [Symbol.asyncDispose]: async (): Promise<void> => {
          session.removeClient(boundClient);
          boundTransport.ydoc.destroy();
        },
      };
    } catch (error) {
      wideEvent.outcome = "error";
      wideEvent.error = error;
      // Tear down the partially-created agent so we don't leak the client's
      // background consume loop or the transport's Y.Doc. disconnectClient is
      // idempotent and removes the client from every session it joined.
      if (client) {
        this.server.disconnectClient(client, "manual");
      }
      transport?.ydoc.destroy();
      throw error;
    } finally {
      wideEvent.duration_ms = Date.now() - startTime;
      emitWideEvent((wideEvent.outcome as string) === "error" ? "error" : "info", wideEvent);
    }
  }
}
