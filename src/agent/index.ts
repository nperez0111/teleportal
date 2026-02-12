import { Message, Observable, ServerContext } from "teleportal";
import { emitWideEvent, Server } from "teleportal/server";
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
    const startTime = Date.now();
    const wideEvent: Record<string, unknown> = {
      event_type: "agent_create",
      timestamp: new Date().toISOString(),
      document_id: message.document,
      client_id: message.context.clientId,
      encrypted: message.encrypted,
    };
    try {
      const observer = new Observable<{
        message: (message: Message) => void;
      }>();
      const transport = getYTransportFromYDoc<ServerContext>({
        document: message.document,
        context: message.context,
        handler,
        observer,
      });

      const client = this.server.createClient({
        transport,
        id: message.context.clientId,
      });

      wideEvent.client_id = client.id;

      const session = await this.server.getOrOpenSession(message.document, {
        encrypted: message.encrypted,
        client,
        context: message.context,
      });

      await observer.call("message", await transport.handler.start());

      await transport.synced;

      wideEvent.outcome = "success";
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
    } catch (error) {
      wideEvent.outcome = "error";
      wideEvent.error = error;
      throw error;
    } finally {
      wideEvent.duration_ms = Date.now() - startTime;
      emitWideEvent(
        (wideEvent.outcome as string) === "error" ? "error" : "info",
        wideEvent,
      );
    }
  }
}
