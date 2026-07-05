# SharedWorker Connection Architecture

Teleportal's SharedWorker subsystem offloads the network connection from the main thread to a [SharedWorker](https://developer.mozilla.org/en-US/docs/Web/API/SharedWorker), allowing all open tabs to share a single underlying transport (WebSocket/HTTP) to the sync server.

## Overview

```
Tab A                          Tab B                        Tab C
 |                              |                            |
WorkerConnection           WorkerConnection            WorkerConnection
 |                              |                            |
MessagePort                MessagePort                 MessagePort
 \                              |                           /
  \                             |                          /
   +-----------+----------------+-----------+--------------+
               |    SharedWorker            |
               |                            |
         ConnectionWorkerManager            |
          |                |                |
    ManagedConnection  ManagedConnection    |
     (key: url+tokenA)  (key: url+tokenB)  |
          |                |                |
    DirectConnection  DirectConnection      |
          |                |                |
     WebSocket/HTTP    WebSocket/HTTP       |
          |                |                |
          +--------+-------+               |
                   |                        |
               Sync Server                  |
```

### Participants

| Component                 | Thread                | Role                                                                                                                                                    |
| ------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WorkerConnection`        | Main thread (per tab) | Proxies the `Connection` interface over a `MessagePort`. Sends upstream commands, receives downstream events/messages.                                  |
| `ConnectionWorkerManager` | SharedWorker          | Manages a pool of `ManagedConnection`s keyed by connection identity. Routes messages between ports and connections.                                     |
| `ManagedConnection`       | SharedWorker          | Wraps a single `DirectConnection`. Handles event forwarding, message fan-out, online/offline reconciliation, grace period cleanup, and file operations. |
| `DirectConnection`        | SharedWorker          | The real connection: transport management, reconnection, message buffering, in-flight tracking.                                                         |
| `WorkerProvider`          | Main thread           | Convenience wrapper that creates a `WorkerConnection` (or falls back to `DirectConnection`) and wires up a `Provider`.                                  |

## Connection Pooling and Sharing

The manager pools connections using a **connection key** derived from the serialized options. By default the key is `URL + token`:

```ts
const defaultConnectionKey = (options) => `${options.url ?? "default"}::${options.token ?? ""}`;
```

Two tabs produce the same key only when both the server URL and token match. This means:

- **Same user, same server**: tabs share one connection and one WebSocket.
- **Different tokens** (different users, or different auth sessions): separate connections. Attribution/identity is derived from the token, so sharing across tokens would mix authors.
- **Custom key function**: pass `getConnectionKey` to `ConnectionWorkerManager` to override. For example, decode the JWT and key on `sub` so the same user shares one connection even across token refreshes.

```ts
const manager = new ConnectionWorkerManager(transportFactory, {
  getConnectionKey: (options) => {
    const claims = decodeJwt(options.token);
    return `${options.url}::${claims.sub}`;
  },
});
```

## Lifecycle

### Init

1. Tab calls `createConnection({ workerUrl, url, token, transports, ... })`.
2. If `SharedWorker` is available, a `WorkerConnection` is created over the worker's `MessagePort`.
3. The `WorkerConnection` sends an `init` message with serialized options and a random `tabId`.
4. The manager computes the connection key. If a `ManagedConnection` exists for that key, the tab joins it (and any pending grace period is cancelled). Otherwise a new `DirectConnection` is created.
5. The manager sends back a `ready` message with the current `ConnectionState`.

### Connected

- The `DirectConnection` connects through its transport stack (WebSocket, HTTP, fallback).
- State updates (`connecting`, `connected`, `disconnected`, `errored`) are forwarded to all attached ports as `state-update` messages.
- `WorkerConnection` derives `connected`/`disconnected` events from these state updates (mirroring `DirectConnection`'s transition logic), so events fire exactly once per transition.

### Disconnect (tab leaves)

1. Tab calls `workerConnection.destroy()`.
2. The `WorkerConnection` sends a `destroy` message upstream, stops its heartbeat, removes network listeners, rejects all pending RPC and file operation promises, closes the fan-out writer, and closes the port.
3. The manager removes the port from the `ManagedConnection`. If ports remain, the connection lives on. If this was the last port, a **grace period** begins.

### Grace Period

When the last tab disconnects, the manager schedules a timer (default 5 seconds, configurable via `gracePeriodMs`). During this window:

- The `DirectConnection` stays alive (WebSocket remains open).
- If a new tab connects with the same key, `cancelGracePeriod()` is called and the tab joins the existing connection. No reconnection handshake with the server is needed.
- If the timer expires, `ManagedConnection.destroy()` is called: event subscriptions are cleaned up, the `DirectConnection` is destroyed (closing the WebSocket), and the entry is removed from the pool.

### Destroy

`ManagedConnection.destroy()`:

1. Cancels any pending grace period timer.
2. Unsubscribes all event listeners from the `DirectConnection`.
3. Calls `DirectConnection.destroy()` (closes transport, clears buffers, clears in-flight messages, closes fan-out writer).

## Heartbeat and Liveness Detection

Each `WorkerConnection` runs a heartbeat loop (default: 5s interval, 2 max misses):

1. Every `intervalMs`, the main thread increments `missedHeartbeats` and posts a `heartbeat` message to the worker.
2. The worker immediately replies with `heartbeat-ack`.
3. On receiving the ack, `missedHeartbeats` is reset to 0.
4. If `missedHeartbeats > maxMisses`, the worker is declared dead:
   - The heartbeat timer is stopped.
   - The connection state is set to `errored` with a "Worker heartbeat timeout" error.
   - The `onWorkerDeath` callback is invoked (if provided).

The `onWorkerDeath` callback is the recovery hook. The caller (typically `createConnection`) can use it to fall back to a `DirectConnection`, notify the user, or attempt to restart the worker.

**Note**: heartbeat detection is per-tab. If one tab's port breaks but the worker is alive, only that tab detects the failure. The worker and other tabs continue normally.

## Online/Offline Reconciliation

Each tab forwards the browser's `online`/`offline` events to the worker via `network-status` messages. The worker maintains per-port online state and uses an **any-tab-online** policy:

```ts
reconcileOnlineState(): void {
  const anyOnline = this.#ports.size === 0 || [...this.#ports].some((p) => p.online);
  // ...dispatch online/offline to the DirectConnection's EventTarget
}
```

- If **any** tab reports online, the connection is considered online and reconnection is allowed.
- Only when **all** tabs report offline does the connection go offline (preventing reconnection attempts).
- When no ports are attached (grace period), `anyOnline` defaults to `true` so the connection stays up during the grace window.

This policy is correct because `navigator.onLine` is a per-browser-context check. A single tab being online means the device has connectivity. The edge case where tabs disagree (one online, one offline) is handled conservatively: the connection stays up.

## Property Synchronization

The worker pushes `property` messages containing:

- `inFlightMessageCount`
- `destroyed`
- `activeTransport`
- `availableTransports`

These are pushed:

- On `init` (initial snapshot via `postProperties`)
- On `connected` event
- On `disconnected` event
- On `messages-in-flight` event

The `WorkerConnection` caches these values locally so that property getters (`inFlightMessageCount`, `destroyed`, etc.) return immediately without cross-thread round-trips.

## Error Propagation

Errors propagate through the same `state-update` channel as all other state changes:

1. Transport failures in the `DirectConnection` trigger a state transition to `errored`.
2. The `ManagedConnection` forwards this as a `state-update` message to all ports.
3. Each `WorkerConnection` calls `#updateState`, which:
   - Rejects the pending `connected` promise (if any) with the error.
   - Emits the `update` event with the errored state.

RPC operations (`connect`, `disconnect`, `switchTransport`) use a request/response pattern with timeout:

- The `WorkerConnection` assigns a `requestId` and sets a 30-second timeout.
- The worker catches errors from the underlying `DirectConnection` method and sends a `response` message with the error string.
- If the worker never responds (crashed), the timeout fires and rejects the promise.

File operations (`uploadFile`, `downloadFile`) use a separate pending-ops map but follow the same pattern, with error messages forwarded as `file-upload-error`/`file-download-error`.

**Consistency with DirectConnection**: The `WorkerConnection` implements the same `Connection` interface and emits the same events with the same transition semantics. Code using the `Connection` interface does not need to know whether it is backed by a `DirectConnection` or `WorkerConnection`.

## Writing a Custom Worker Entry Point

The default entry point (`connection-worker.ts`) maps `TransportDescriptor`s to built-in transports. To add custom transports or configuration:

```ts
// my-worker.ts
import { ConnectionWorkerManager } from "teleportal/providers/worker";
import { websocketTransport } from "teleportal/providers";
import { myCustomTransport } from "./my-transport";

const manager = new ConnectionWorkerManager(
  (options) => {
    // Map descriptors to transport instances
    return (options.transports ?? []).map((desc) => {
      switch (desc.type) {
        case "websocket":
          return websocketTransport(desc.options);
        case "my-custom":
          return myCustomTransport(desc.options);
        default:
          throw new Error(`Unknown transport: ${desc.type}`);
      }
    });
  },
  {
    gracePeriodMs: 10_000, // 10s grace period
    getConnectionKey: (options) => {
      // Custom pooling logic — e.g. key on user ID, not token
      return `${options.url}::${parseUserId(options.token)}`;
    },
  },
);

declare const self: { onconnect: ((event: MessageEvent) => void) | null };
self.onconnect = (event: MessageEvent) => {
  manager.addPort(event.ports[0]);
};
```

Then reference it from the main thread:

```ts
import { createConnection } from "teleportal/providers/worker";

const connection = createConnection({
  workerUrl: new URL("./my-worker.ts", import.meta.url),
  url: "wss://example.com/sync",
  token: { token: jwt },
  transports: [websocketTransport(), httpTransport()], // fallback if worker fails
  workerTransports: [
    { type: "websocket", options: { timeout: 5000 } },
    { type: "my-custom", options: { ... } },
  ],
});
```

## Configuration Options

### `createConnection` / `CreateConnectionOptions`

| Option                    | Type                    | Default    | Description                                                                                         |
| ------------------------- | ----------------------- | ---------- | --------------------------------------------------------------------------------------------------- |
| `workerUrl`               | `string \| URL`         | -          | URL of the SharedWorker script. Omit to use a direct connection.                                    |
| `url`                     | `string`                | (required) | Sync server URL.                                                                                    |
| `token`                   | `TokenOptions`          | -          | Authentication token.                                                                               |
| `transports`              | `ConnectionTransport[]` | (required) | Transport instances for the direct fallback path.                                                   |
| `workerTransports`        | `TransportDescriptor[]` | -          | Serializable transport descriptors forwarded to the worker.                                         |
| `onWorkerDeath`           | `() => void`            | -          | Called if the SharedWorker crashes or heartbeat times out.                                          |
| `connect`                 | `boolean`               | `true`     | Auto-connect on creation.                                                                           |
| `maxReconnectAttempts`    | `number`                | 10         | Max reconnection attempts before giving up.                                                         |
| `initialReconnectDelay`   | `number`                | 100        | Initial backoff delay (ms).                                                                         |
| `maxBackoffTime`          | `number`                | 30000      | Maximum backoff delay (ms).                                                                         |
| `reconnectBackoffFactor`  | `number`                | 1.3        | Backoff multiplier per attempt.                                                                     |
| `heartbeatInterval`       | `number`                | 0          | Server-level heartbeat interval (ms). 0 = disabled.                                                 |
| `messageReconnectTimeout` | `number`                | 30000      | Reconnect if no messages received within this period.                                               |
| `batchIntervalMs`         | `number`                | 100        | Target batch interval for outgoing updates (ms); the ack-decay recovery floor. 0 disables batching. |
| `maxBatchIntervalMs`      | `number`                | 5000       | Maximum batch interval (AIMD upper bound).                                                          |

### `ConnectionWorkerManagerOptions`

| Option                 | Type                  | Default     | Description                                                                                                                                              |
| ---------------------- | --------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gracePeriodMs`        | `number`              | 5000        | How long to keep a connection alive after the last tab disconnects.                                                                                      |
| `getConnectionKey`     | `(options) => string` | URL + token | Custom function to determine which tabs share a connection.                                                                                              |
| `stalePortCheckMs`     | `number`              | 60000       | How often (ms) the manager checks for ports whose tab-side heartbeat has stopped. Fallback for browsers without the MessagePort `close` event.           |
| `stalePortThresholdMs` | `number`              | 300000      | A port that has heartbeated before is considered stale when its last heartbeat is older than this (ms). Must exceed browser hidden-tab timer throttling. |

### `WorkerConnection` Constructor

| Option          | Type         | Description                                                   |
| --------------- | ------------ | ------------------------------------------------------------- |
| `onWorkerDeath` | `() => void` | Callback invoked when the heartbeat declares the worker dead. |

### Heartbeat (`startHeartbeat`)

| Parameter    | Type     | Default | Description                                               |
| ------------ | -------- | ------- | --------------------------------------------------------- |
| `intervalMs` | `number` | 5000    | Interval between heartbeat pings.                         |
| `maxMisses`  | `number` | 2       | Consecutive missed acks before declaring the worker dead. |
