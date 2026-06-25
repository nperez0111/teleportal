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

  async function flushBatch() {
    clearBatchTimer();
    const updates = pendingUpdates;
    if (updates.length === 0) return;
    pendingUpdates = [];

    const merged: VersionedUpdate = {
      version: 2,
      data: updates.length === 1 ? updates[0] : mergeUpdates(updates),
    };
    channel.trySend(await handler.onUpdate(merged));
  }

  const onUpdate = ydoc.on("update", async (update: Uint8Array, origin: any) => {
    if (origin === getSyncTransactionOrigin(ydoc) || isDestroyed) {
      return;
    }

    if (updateBatchIntervalMs <= 0) {
      const versioned: VersionedUpdate = { version: 1, data: update as UpdateV1 };
      channel.trySend(await handler.onUpdate(versioned));
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
  let onSynced: (success: boolean) => void;
  let closed = false;

  // Settle the `synced` promise exactly once; later calls are no-ops.
  const settleSync = (success: boolean) => {
    onSynced(success);
    onSynced = () => {};
  };

  const synced = new Promise<void>((resolve, reject) => {
    onSynced = (success: boolean) => {
      if (success) resolve();
      else reject(new Error("YDoc cancelled"));
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
                handler.handleAwarenessUpdate(chunk.payload.update);
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
          case "presence":
            break;
          default: {
            const _exhaustive: never = chunk;
            void _exhaustive;
            break;
          }
        }
      } catch (err) {
        settleSync(false);
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
