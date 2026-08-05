import type { KeyResolver } from "teleportal/encryption-key";
import { emitWideEvent, Server } from "teleportal/server";
import {
  DirectConnection,
  Provider,
  serverTransport,
  type DefaultTransportProperties,
  type RpcExtensionMap,
} from "teleportal/providers";
import type { ClientContext, ServerContext, Transport } from "teleportal";

export interface CreateAgentOptions<R extends RpcExtensionMap = {}> {
  /** The document id the agent should open. */
  document: string;
  /**
   * The authenticated {@link ServerContext} the agent acts as. `clientId`
   * identifies the agent's connection; `userId`/`room` scope its access
   * exactly as they would for a remote client.
   */
  context: ServerContext;
  /**
   * The key used for end-to-end content encryption, forwarded verbatim to the
   * underlying {@link Provider}.
   *
   * End-to-end encryption is the default: pass a `CryptoKey` (or a
   * {@link KeyResolver}) so the agent reads and writes plaintext locally while
   * the wire and storage stay encrypted. To act on an unencrypted document,
   * pass `false`. Omitting this throws — encryption is never silently skipped.
   */
  encryptionKey: CryptoKey | false | KeyResolver;
  /**
   * Typed RPC extension map, forwarded to the {@link Provider}. Lets the agent
   * *call* server RPC methods via `agent.rpc.*` and await typed responses.
   */
  rpc?: R;
}

/**
 * Create a server-side agent for a document.
 *
 * An agent is a full {@link Provider} that participates in a document from
 * inside the server process, over an in-process {@link serverTransport} rather
 * than a socket. It has the same surface as a browser `Provider` — `doc`,
 * `awareness`, `rpc`, presence, and the `synced`/`loaded` promises — so
 * server-side code can read, write, observe, and call RPC methods on a document
 * exactly as a client would, with no network hop.
 *
 * The returned `Provider` owns a fresh `Y.Doc` and `Awareness`. Dispose it with
 * `provider.destroy()` (or `using`/`Symbol.dispose`) to tear down the agent's
 * connection and remove it from the session.
 *
 * @example
 * ```ts
 * const agent = await createAgent(server, {
 *   document: "doc-1",
 *   context: { userId: "system", room: "room-1", clientId: "agent-1" },
 *   encryptionKey: false,
 * });
 * await agent.synced;
 * agent.doc.getText("content").insert(0, "hello from the server");
 * agent.destroy();
 * ```
 */
export async function createAgent<R extends RpcExtensionMap = {}>(
  server: Server<ServerContext>,
  options: CreateAgentOptions<R>,
): Promise<Provider<Transport<ClientContext, DefaultTransportProperties>, R>> {
  if (!options.document) {
    throw new Error("Document is required");
  }

  const startTime = Date.now();
  const clientId = options.context.clientId;
  const wideEvent: Record<string, unknown> = {
    event_type: "agent_create",
    timestamp: new Date().toISOString(),
    document_id: options.document,
    client_id: clientId,
    encrypted: options.encryptionKey !== false,
  };

  // Resources created before sync completes. If any step throws we must tear
  // these down or we leak the client's background consume loop, and — once the
  // Provider exists — its Y.Doc, subdoc listener, and presence timers too.
  let connection: DirectConnection | undefined;
  let provider: Provider<Transport<ClientContext, DefaultTransportProperties>, R> | undefined;
  try {
    connection = new DirectConnection({
      transports: [serverTransport(server, { id: clientId, context: options.context })],
      connect: false,
      // In-process: there is no network round-trip to amortize, so batching
      // only adds latency. Flush every message immediately.
      batchIntervalMs: 0,
    });

    // Provider.create awaits `connection.connected` but never initiates the
    // connection itself — establish the in-process link first.
    await connection.connect();

    provider = await Provider.create<Transport<ClientContext, DefaultTransportProperties>, R>({
      connection,
      document: options.document,
      encryptionKey: options.encryptionKey,
      // Server processes have no IndexedDB, and the document is already
      // durable in the server's own storage — never persist offline.
      enableOfflinePersistence: false,
      rpc: options.rpc,
    });

    await provider.synced;

    wideEvent.outcome = "success";
    return provider;
  } catch (error) {
    wideEvent.outcome = "error";
    wideEvent.error = error;
    // Tear down the partially-created agent. Once the Provider exists it owns
    // the connection, so destroying it is what releases everything — the Y.Doc,
    // the subdoc listener, the presence extension's timers, and the connection
    // (and with it the client's background consume loop). This path is reached
    // in practice: `synced` rejects when the agent holds the wrong encryption
    // key for the document. Before the Provider exists, the connection is all
    // there is; destroy() is safe on a half-open one.
    if (provider) {
      provider.destroy();
    } else {
      connection?.destroy();
    }
    throw error;
  } finally {
    wideEvent.duration_ms = Date.now() - startTime;
    emitWideEvent((wideEvent.outcome as string) === "error" ? "error" : "info", wideEvent);
  }
}
