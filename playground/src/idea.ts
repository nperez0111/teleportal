import { Message } from "teleportal";
import { Agent } from "teleportal/agent";
import { getHTTPHandlers } from "teleportal/http";
import { Server } from "teleportal/server";
import { YDocStorage } from "teleportal/storage";

const server = new Server({
  storage: new YDocStorage(),
});

const handleRequest = getHTTPHandlers({
  server,
  getContext: () => {
    return { userId: "nick", room: "test" };
  },
});

await addDevtoolsObservability();

const agent = new Agent(server);
function getTransport(id: string) {
  return agent.createAgent({
    document: "test",
    context: { clientId: id, userId: `user-${id}`, room: "test" },
    encrypted: false,
  });
}
const agentInstance1 = await getTransport("abc-123");
const agentInstance2 = await getTransport("def-456");

// connection.call("connected");
agentInstance1.client;
await new Promise((resolve) => setTimeout(resolve, 100));
agentInstance1.ydoc.getText("test").insert(0, "hello");
await new Promise((resolve) => setTimeout(resolve, 100));
agentInstance2.ydoc.getText("test").insert("hello".length, " world");
await new Promise((resolve) => setTimeout(resolve, 100));

// connection.call('received-message', )
(await handleRequest(new Request(new URL("/metrics", window.location.origin))))
  .text()
  .then(console.log);

console.log(agentInstance1.ydoc.getText("test").toString());

import {
  Connection,
  Provider,
  teleportalEventClient,
} from "teleportal/providers";
/**
 * There is probably a better way to do this, but this is a quick and dirty way to add events into the devtools.
 */
async function addDevtoolsObservability() {
  class MockConnection extends Connection {
    constructor() {
      super();
      // Initialize the state with the correct HTTP context
      this._state = {
        type: "disconnected",
        context: { clientId: null, lastEventId: null },
      };
    }
    async initConnection(): Promise<void> {
      // Set state to connecting first
      this.setState({
        type: "connecting",
        context: {
          clientId: this.state.context.clientId,
          lastEventId: this.state.context.lastEventId,
        },
      });
      // Simulate connection
      await new Promise((resolve) => setTimeout(resolve, 0));
      this.setState({
        type: "connected",
        context: { clientId: "test-client", connectionType: "mock" },
      });
    }
    async sendMessage(message: Message): Promise<void> {}
    async closeConnection(): Promise<void> {}
  }

  const connection = new MockConnection();

  const provider = await Provider.create({
    document: "test",
    connection,
  });

  server.on("client-message", ({ clientId, message, direction }) => {
    if (clientId !== "abc-123") return;
    if (direction === "out") {
      teleportalEventClient.emit("received-message", {
        message,
        provider,
        connection,
      });
    } else {
      teleportalEventClient.emit("sent-message", {
        message,
        provider,
        connection,
      });
    }
  });

  connection.call("connected");
}
