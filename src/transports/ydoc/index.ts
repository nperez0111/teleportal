import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";

import {
  AwarenessMessage,
  type AwarenessUpdateMessage,
  type ClientContext,
  DocMessage,
  Message,
  Observable,
  type Sink,
  type Source,
  type StateVector,
  type SyncStep2UpdateV2,
  type Transport,
  type UpdateV1,
  type UpdateV2,
  type VersionedSyncStep2Update,
  type VersionedUpdate,
} from "teleportal";
import { convertToV2, mergeUpdates } from "teleportal/protocol";
import {
  decodeContentEncryptedPayload,
  encodeContentEncryptedPayload,
  type EncryptedUpdatePayload,
} from "teleportal/protocol/encryption";
import { compose } from "teleportal/transports";
import { createChannel } from "../../lib/iter";

export function getSyncTransactionOrigin(ydoc: Y.Doc) {
  return ydoc.clientID + "-sync";
}

export interface YDocSourceHandler {
  onUpdate(update: VersionedUpdate): Promise<Message>;
  onAwarenessUpdate(update: AwarenessUpdateMessage): Promise<Message>;
  start(): Promise<Message>;
  destroy?: () => void;
}

export interface YDocSinkHandler {
  handleSyncStep1(stateVector: StateVector): Promise<DocMessage<ClientContext>>;
  handleSyncStep2(syncStep2: VersionedSyncStep2Update): Promise<void | Message<ClientContext>>;
  handleUpdate(update: VersionedUpdate): Promise<void>;
  handleAwarenessUpdate(update: AwarenessUpdateMessage): Promise<void>;
  handleAwarenessRequest(update: AwarenessUpdateMessage): Promise<AwarenessMessage<ClientContext>>;
}

/**
 * Makes a {@link Source} from a {@link Y.Doc} and a document name
 */
export function getYDocSource<Context extends ClientContext>({
  ydoc = new Y.Doc(),
  context = { clientId: "local" } as Context,
  document,
  awareness = new Awareness(ydoc),
  observer = new Observable<{
    message: (message: Message) => void;
  }>(),
  updateBatchIntervalMs = 0,
  handler = {
    async onUpdate(update: VersionedUpdate) {
      const v2 = update.version === 2 ? update.data : convertToV2(update);
      const payload = encodeContentEncryptedPayload({
        structureUpdate: v2,
        encryptedSidecars: [],
      });
      return new DocMessage(
        document,
        {
          type: "update",
          update: { version: 2, data: payload } as unknown as VersionedUpdate,
        },
        context,
      );
    },
    async onAwarenessUpdate(update) {
      return new AwarenessMessage(
        document,
        {
          type: "awareness-update",
          update: update as AwarenessUpdateMessage,
        },
        context,
      );
    },
    async start() {
      return new DocMessage(
        document,
        {
          type: "sync-step-1",
          sv: Y.encodeStateVector(ydoc) as StateVector,
        },
        context,
      );
    },
  },
}: {
  ydoc?: Y.Doc;
  context?: Context;
  document: string;
  awareness?: Awareness;
  observer?: Observable<{
    message: (message: Message) => void;
  }>;
  handler?: YDocSourceHandler;
  /**
   * Batch interval in ms for merging cleartext updates before passing them
   * to the handler. When > 0, rapid Y.Doc updates are accumulated and merged
   * via `Y.mergeUpdatesV2` so the handler receives fewer, larger updates.
   * Set to 0 to disable (every update is forwarded immediately).
   *
   * @default 0
   */
  updateBatchIntervalMs?: number;
}): Source<
  Context,
  {
    ydoc: Y.Doc;
    awareness: Awareness;
    handler: YDocSourceHandler;
    drainPendingUpdates: () => Promise<void>;
  }
> {
  const channel = createChannel<Message<Context>>();
  let isDestroyed = false;

  let pendingUpdates: UpdateV2[] = [];
  let batchTimer: ReturnType<typeof setTimeout> | null = null;

  function clearBatchTimer() {
    if (batchTimer !== null) {
      clearTimeout(batchTimer);
      batchTimer = null;
    }
  }

  // Y.js emits `update` synchronously in clock order, but `handler.onUpdate` is
  // async — for an encrypted document it is an off-thread WebCrypto call. So
  // awaiting it inline lets a later update finish encrypting first and reach the
  // channel ahead of an earlier one. The server appends updates in the order it
  // receives them, so a shuffled burst leaves its pending log transiently gappy;
  // a client that handshakes inside that window is served a gap-clipped prefix
  // and silently loses the tail forever (it is not left parked, so no watchdog
  // ever rescues it).
  //
  // Keep the encryption concurrent — start the work immediately — but release
  // the results onto the channel strictly in the order they were produced.
  let sendChain: Promise<void> = Promise.resolve();
  function sendInOrder(pending: Promise<Message<Context>>): Promise<void> {
    // Mark `pending` handled now: it may reject long before the chain reaches
    // it, which would otherwise surface as an unhandled rejection.
    pending.catch(() => {});
    const settled = sendChain.then(async () => {
      channel.trySend(await pending);
    });
    // Callers observe failures through `settled`; the chain itself continues
    // clean so one bad update cannot poison every later send.
    sendChain = settled.catch(() => {});
    return settled;
  }

  async function flushBatch() {
    clearBatchTimer();
    const updates = pendingUpdates;
    if (updates.length === 0) return;
    pendingUpdates = [];

    const merged: VersionedUpdate = {
      version: 2,
      data: updates.length === 1 ? updates[0] : mergeUpdates(updates),
    };
    await sendInOrder(handler.onUpdate(merged));
  }

  const onUpdate = ydoc.on("update", async (update: Uint8Array, origin: any) => {
    if (origin === getSyncTransactionOrigin(ydoc) || isDestroyed) {
      return;
    }

    if (updateBatchIntervalMs <= 0) {
      const versioned: VersionedUpdate = { version: 1, data: update as UpdateV1 };
      await sendInOrder(handler.onUpdate(versioned));
      return;
    }

    const v2 = convertToV2({ version: 1, data: update as UpdateV1 });
    pendingUpdates.push(v2);
    if (batchTimer === null) {
      batchTimer = setTimeout(() => {
        batchTimer = null;
        void flushBatch();
      }, updateBatchIntervalMs);
    }
  });

  // Shared teardown for both ydoc and awareness `destroy` events.
  async function shutdown() {
    if (isDestroyed) return;
    isDestroyed = true;
    await flushBatch();
    // Sends are queued rather than awaited inline, so drain the queue before
    // closing — otherwise a `destroy()` right after an edit closes the channel
    // out from under updates that were already produced, and they are lost.
    await sendChain;
    if (handler.destroy) await handler.destroy();
    channel.close();
  }

  const onDestroy = ydoc.on("destroy", shutdown);

  const onAwarenessUpdate = async (_clients: any, origin: any) => {
    if (origin === getSyncTransactionOrigin(ydoc) || isDestroyed) return;
    const update = encodeAwarenessUpdate(awareness, [awareness.clientID]) as AwarenessUpdateMessage;
    channel.trySend(await handler.onAwarenessUpdate(update));
  };
  awareness.on("update", onAwarenessUpdate);

  const onAwarenessDestroy = shutdown;
  awareness.on("destroy", onAwarenessDestroy);

  const onMessage = (message: Message) => {
    channel.trySend(message as Message<Context>);
  };
  observer.on("message", onMessage);

  // Wrap the channel with cleanup on iteration end
  async function* sourceWithCleanup(): AsyncIterable<Message<Context>[]> {
    try {
      yield* channel;
    } finally {
      isDestroyed = true;
      clearBatchTimer();
      pendingUpdates = [];
      ydoc.off("update", onUpdate);
      ydoc.off("destroy", onDestroy);
      awareness.off("update", onAwarenessUpdate);
      awareness.off("destroy", onAwarenessDestroy);
      observer.off("message", onMessage);
    }
  }

  return {
    ydoc,
    awareness,
    handler,
    /**
     * Resolve once every update produced so far has been handed to the channel.
     *
     * A local edit reaches the wire asynchronously — `handler.onUpdate` encrypts
     * off-thread — so for a window after `ydoc` mutates there is an update that
     * no downstream component can see yet: it is not in the channel, so the
     * connection does not count it in flight, so `Provider.flush()` considers
     * there to be nothing to wait for and resolves while the edit is still in
     * this source. Callers that need "everything I wrote is really on its way"
     * must drain here first.
     */
    async drainPendingUpdates() {
      // A batched update may still be sitting in `pendingUpdates` behind its
      // timer; send it now rather than waiting the interval out.
      await flushBatch();
      await sendChain;
    },
    source: sourceWithCleanup(),
  };
}

/** Makes a {@link Sink} from a {@link Y.Doc} and a document name. */
export function getYDocSink<Context extends ClientContext>({
  ydoc = new Y.Doc(),
  context,
  document,
  awareness = new Awareness(ydoc),
  observer = new Observable<{
    message: (message: Message) => void;
  }>(),
  handler = {
    async handleAwarenessUpdate(update) {
      applyAwarenessUpdate(awareness, update, getSyncTransactionOrigin(ydoc));
    },
    async handleAwarenessRequest(update) {
      return new AwarenessMessage(
        document,
        {
          type: "awareness-update",
          update,
        },
        context,
      );
    },
    async handleSyncStep1(stateVector) {
      const diff = Y.encodeStateAsUpdateV2(ydoc, stateVector);
      const payload = encodeContentEncryptedPayload({
        structureUpdate: diff,
        encryptedSidecars: [],
      });
      return new DocMessage(
        document,
        {
          type: "sync-step-2",
          update: {
            version: 2,
            data: payload as unknown as SyncStep2UpdateV2,
          },
        },
        context,
      );
    },
    async handleSyncStep2(syncStep2) {
      const decoded = decodeContentEncryptedPayload(
        syncStep2.data as unknown as EncryptedUpdatePayload,
      );
      if (decoded.structureUpdate.length > 0) {
        Y.applyUpdateV2(ydoc, decoded.structureUpdate, getSyncTransactionOrigin(ydoc));
      }
    },
    async handleUpdate(update) {
      const decoded = decodeContentEncryptedPayload(update.data as EncryptedUpdatePayload);
      if (decoded.structureUpdate.length > 0) {
        Y.applyUpdateV2(ydoc, decoded.structureUpdate, getSyncTransactionOrigin(ydoc));
      }
    },
  },
}: {
  ydoc?: Y.Doc;
  context?: Context;
  document: string;
  awareness?: Awareness;
  observer?: Observable<{
    message: (message: Message) => void;
  }>;
  handler?: YDocSinkHandler;
}): Sink<
  Context,
  {
    ydoc: Y.Doc;
    awareness: Awareness;
    synced: Promise<void>;
  }
> {
  let onSynced: (success: boolean, error?: Error) => void;
  let closed = false;

  // Settle the `synced` promise exactly once; later calls are no-ops.
  const settleSync = (success: boolean, error?: Error) => {
    onSynced(success, error);
    onSynced = () => {};
  };

  const synced = new Promise<void>((resolve, reject) => {
    onSynced = (success: boolean, error?: Error) => {
      if (success) resolve();
      else reject(error ?? new Error("YDoc cancelled"));
    };
  });
  // Awaiting `synced` is optional. `close()` rejects it (e.g. switching
  // documents before sync completes), so attach a no-op rejection handler to
  // keep an unconsumed `synced` from surfacing as an unhandled rejection. Real
  // consumers attach their own handlers and still observe the rejection.
  synced.catch(() => {});

  return {
    synced,
    ydoc,
    awareness,
    async write(chunk) {
      if (closed) return;
      try {
        if (
          (chunk.type === "doc" || chunk.type === "awareness") &&
          (chunk.document !== document || chunk.context.clientId === "local")
        ) {
          return;
        }
        if (ydoc.isDestroyed) {
          throw new Error("YDoc is destroyed");
        }
        switch (chunk.type) {
          case "awareness": {
            switch (chunk.payload.type) {
              case "awareness-update": {
                // Awareness is best-effort: a peer state we cannot apply (e.g.
                // an encrypted document where this client holds the wrong key)
                // must be ignored rather than tear down the stream — and must
                // never escape as an unhandled rejection.
                await handler.handleAwarenessUpdate(chunk.payload.update).catch(() => {});
                break;
              }
              case "awareness-request": {
                const update = encodeAwarenessUpdate(awareness, [
                  awareness.clientID,
                ]) as AwarenessUpdateMessage;
                observer.call("message", await handler.handleAwarenessRequest(update));
                break;
              }
              default: {
                const _exhaustive: never = chunk.payload;
                throw new Error("Invalid chunk.payload.type", {
                  cause: { chunk: _exhaustive },
                });
              }
            }
            break;
          }
          case "doc": {
            switch (chunk.payload.type) {
              case "sync-step-1": {
                const response = await handler.handleSyncStep1(chunk.payload.sv);
                observer.call("message", response);
                break;
              }
              case "sync-step-2": {
                const compaction = await handler.handleSyncStep2(chunk.payload.update);
                if (compaction) {
                  observer.call("message", compaction);
                }
                break;
              }
              case "update": {
                await handler.handleUpdate(chunk.payload.update);
                break;
              }
              case "sync-done": {
                settleSync(true);
                break;
              }
              case "auth-message": {
                throw new Error(chunk.payload.reason);
              }
              default: {
                const _exhaustive: never = chunk.payload;
                throw new Error("Invalid chunk.payload.type", {
                  cause: { chunk: _exhaustive },
                });
              }
            }
            break;
          }
          case "rpc":
          case "ack":
            break;
          default: {
            const _exhaustive: never = chunk;
            void _exhaustive;
            break;
          }
        }
      } catch (err) {
        settleSync(false, err instanceof Error ? err : new Error(String(err)));
        throw err;
      }
    },
    close() {
      closed = true;
      settleSync(false);
    },
  };
}

/** Makes a {@link Transport} from a {@link Y.Doc} and a document name. */
export function getYTransportFromYDoc<Context extends ClientContext>({
  ydoc = new Y.Doc(),
  context = { clientId: "local" } as Context,
  document,
  awareness = new Awareness(ydoc),
  handler,
  observer = new Observable<{
    message: (message: Message) => void;
  }>(),
}: {
  ydoc?: Y.Doc;
  context?: Context;
  document: string;
  awareness?: Awareness;
  handler?: YDocSinkHandler & YDocSourceHandler;
  /** An observer which can inject messages into the source stream. */
  observer?: Observable<{
    message: (message: Message) => void;
  }>;
}): Transport<
  Context,
  {
    ydoc: Y.Doc;
    awareness: Awareness;
    synced: Promise<void>;
    handler: Pick<YDocSourceHandler, "start">;
  }
> {
  return compose(
    getYDocSource<Context>({
      ydoc,
      awareness,
      document,
      observer,
      handler,
      context,
    }),
    getYDocSink<Context>({
      ydoc,
      awareness,
      document,
      observer,
      handler,
      context,
    }),
  );
}
