import { Message } from "teleportal";
import { Agent } from "teleportal/agent";
import { getHTTPHandlers } from "teleportal/http";
import { Server } from "teleportal/server";
import { MemoryDocumentStorage } from "teleportal/storage";

const server = new Server({
  storage: new MemoryDocumentStorage(),
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
void agentInstance1.client;
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
  createMemoryTransportPair,
} from "teleportal/providers";
/**
 * There is probably a better way to do this, but this is a quick and dirty way to add events into the devtools.
 */
async function addDevtoolsObservability() {
  const [clientTransport] = createMemoryTransportPair();

  const connection = new Connection({
    transports: [clientTransport],
    connect: false,
  });

  await connection.connect();

  const provider = await Provider.create({
    document: "test",
    connection,
    // plaintext for this demo
    encryptionKey: false,
  });

  server.on("client-message", ({ clientId, message, direction }) => {
    if (clientId !== "abc-123") return;
    if (direction === "out") {
      teleportalEventClient.emit("teleportal-provider:received-message", {
        message,
        provider,
        connection,
      });
    } else {
      teleportalEventClient.emit("teleportal-provider:sent-message", {
        message,
        provider,
        connection,
      });
    }
  });
}
