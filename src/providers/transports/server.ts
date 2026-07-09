import type { Message, RawReceivedMessage, ServerContext, Transport } from "teleportal";
import type { Server } from "teleportal/server";
import { createChannel } from "../../lib/iter";
import type { ConnectionTransport, TransportConnectContext } from "./types";

export interface ServerTransportOptions {
  /**
   * The client id to register with the server. Defaults to the
   * `clientId` from the supplied {@link ServerTransportOptions.context}.
   */
  id?: string;
  /**
   * The authenticated {@link ServerContext} to attach to every message the
   * client sends — the same role the websocket server plays in production,
   * where the transport layer stamps the authenticated identity onto inbound
   * messages before they reach the session.
   */
  context: ServerContext;
}

/**
 * An in-process {@link ConnectionTransport} backed directly by a {@link Server}.
 *
 * This is the loopback equivalent of {@link websocketTransport}/{@link httpTransport}:
 * instead of talking to a remote server over a socket, it bridges the client
 * straight into `server.createClient(...)` in the same process. Messages flow
 * through the server's real rate-limited and validated transport chain, so a
 * `Provider` built on this transport behaves exactly as it would over the wire.
 *
 * Use it to run a full-featured `Provider` server-side (see `teleportal/agent`),
 * or to wire two servers together in tests without a network.
 */
export function serverTransport(
  server: Server<ServerContext>,
  options: ServerTransportOptions,
): ConnectionTransport {
  const clientId = options.id ?? options.context.clientId;

  // Per-connection state, replaced wholesale on every `connect()`. A single
  // transport object is reused across reconnections (the connection calls
  // `connect()` again on the same instance), and the SAME client id is reused
  // each time. That means a stale connection's deferred teardown — the server's
  // consume-loop `finally` calling our old `transport.close`, or a late
  // `client-disconnect` event — can fire AFTER a newer `connect()` has already
  // installed a fresh channel/ctx. To stop the stale teardown from tearing down
  // the NEW connection, each connection gets its own `epoch` object; every
  // teardown path captures the epoch it belongs to and no-ops unless it is still
  // the active one.
  type Epoch = {
    channel: ReturnType<typeof createChannel<Message<ServerContext>>>;
    ctx: TransportConnectContext;
    unsubscribeDisconnect: (() => void) | null;
    closed: boolean;
  };
  let active: Epoch | null = null;

  // Tear down one connection epoch. `initiator` distinguishes who closed it:
  //  - "client": the connection called `transport.close()` (disconnect/destroy).
  //    The connection already knows, so we must NOT re-notify it.
  //  - "server": the server ended the consume loop and called our transport's
  //    `close` (stream-ended / error / eviction). The client-facing connection
  //    is otherwise blind to this, so we surface it via `ctx.onClose()` — that
  //    flips the connection to "disconnected" and lets its reconnect/error
  //    machinery run instead of believing it is still connected.
  const close = (epoch: Epoch, initiator: "client" | "server") => {
    if (epoch.closed) return;
    epoch.closed = true;
    epoch.unsubscribeDisconnect?.();
    epoch.unsubscribeDisconnect = null;
    epoch.channel.close();

    // Only disconnect server-side if this epoch is still the active one. A stale
    // epoch's client has already been superseded server-side by the newer
    // connection re-registering under the same id, so disconnecting here would
    // evict the NEW client. Passing the id is safe only for the active epoch.
    if (active === epoch) {
      active = null;
      // Idempotent: harmless if the server already ended the loop itself.
      server.disconnectClient(clientId, "manual");
      if (initiator === "server") {
        epoch.ctx.onClose();
      }
    }
    // A stale ("server"-initiated) close must NOT call `ctx.onClose()`: doing so
    // would bounce the freshly reconnected connection back to "disconnected".
  };

  return {
    name: "server",
    // In-process connect either succeeds synchronously or throws; it never
    // hangs on a network. Keep the ceiling tight so a genuine stall surfaces
    // fast instead of waiting out the 10s network default.
    timeout: 1000,

    async connect(ctx: TransportConnectContext) {
      const ch = createChannel<Message<ServerContext>>();
      const epoch: Epoch = {
        channel: ch,
        ctx,
        unsubscribeDisconnect: null,
        closed: false,
      };
      active = epoch;

      const transport: Transport<ServerContext> = {
        source: ch as AsyncIterable<Message<ServerContext>[]>,
        // Server → client: deliver to the connection's inbound callback, the
        // same seam a socket's onmessage would use.
        write: async (message) => {
          if (epoch.closed) return;
          ctx.onMessage(message as unknown as RawReceivedMessage);
        },
        // The server's consume loop calls this in its `finally` when the client
        // is torn down server-side — treat it as a server-initiated close of
        // THIS epoch (a stale one no-ops via the `active === epoch` guard).
        close: () => close(epoch, "server"),
      };

      try {
        server.createClient({ transport, id: clientId });
        // The server can also evict a client without the consume loop ending
        // (e.g. `disconnectClient` on shutdown/eviction), which never reaches
        // our `transport.close`. Listen for that so a server-initiated teardown
        // still surfaces to the connection as a close.
        epoch.unsubscribeDisconnect = server.on("client-disconnect", ({ clientId: id }) => {
          if (id === clientId) {
            close(epoch, "server");
          }
        });
      } catch (error) {
        // If registration fails partway (or anything below throws), make sure
        // we don't leak the channel or a half-registered client. `close()` is
        // idempotent and safe even if the client was never created.
        close(epoch, "client");
        throw error;
      }
    },

    // Client → server: stamp the authenticated context (a client can never
    // spoof its identity) and enqueue for the server's consume loop.
    //
    // `Message` is a class carrying lazy, cached wire encoding in private
    // fields (`#encoded`/`#id`), so it cannot be structurally cloned — a spread
    // strips the prototype and `Object.create` leaves the private slots
    // uninitialised. Instead we stamp `.context` in place. This is safe because
    // the context is NOT part of the wire encoding (`.encoded`/`.id` are
    // independent of it — see `encodeMessage`), so the connection's in-flight
    // tracking keyed by `.id` is unaffected. It also mirrors the production
    // websocket path, where the server authoritatively attaches the
    // authenticated identity to each inbound message.
    async send(message: Message) {
      if (!active || active.closed) {
        throw new Error("Server transport not connected");
      }
      Object.assign(message.context, options.context);
      active.channel.send(message as Message<ServerContext>);
    },

    async close() {
      if (active) close(active, "client");
    },
  };
}
