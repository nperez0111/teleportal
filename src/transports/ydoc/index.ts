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
      const v1 = update.version === 2 ? Y.convertUpdateFormatV2ToV1(update.data) : update.data;
      const payload = encodeContentEncryptedPayload({
        structureUpdate: v1,
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
  let onUpdate: (...args: any[]) => void;
  let onDestroy: (...args: any[]) => void;
  let onAwarenessUpdate: (...args: any[]) => void;
  let onAwarenessDestroy: (...args: any[]) => void;
  let onMessage: (message: Message) => void;
  let isDestroyed = false;

  let pendingUpdates: UpdateV2[] = [];
  let batchTimer: ReturnType<typeof setTimeout> | null = null;

  function clearBatchTimer() {
    if (batchTimer !== null) {
      clearTimeout(batchTimer);
      batchTimer = null;
    }
  }

  async function flushBatch(controller: ReadableStreamDefaultController<Message>) {
    clearBatchTimer();
    const updates = pendingUpdates;
    if (updates.length === 0) return;
    pendingUpdates = [];

    const merged: VersionedUpdate = {
      version: 2,
      data: updates.length === 1 ? updates[0] : mergeUpdates(updates),
    };
    try {
      controller.enqueue(await handler.onUpdate(merged));
    } catch (err: any) {
      if (
        err?.code !== "ERR_INVALID_STATE" &&
        err?.message !== "Invalid state: Controller is already closed"
      ) {
        throw err;
      }
    }
  }

  return {
    ydoc,
    awareness,
    handler,
    readable: new ReadableStream({
      async start(controller) {
        onUpdate = ydoc.on("update", async (update: Uint8Array, origin: any) => {
          if (origin === getSyncTransactionOrigin(ydoc) || isDestroyed) {
            return;
          }

          if (updateBatchIntervalMs <= 0) {
            try {
              const versioned: VersionedUpdate = { version: 1, data: update as UpdateV1 };
              controller.enqueue(await handler.onUpdate(versioned));
            } catch (err: any) {
              if (
                err?.code !== "ERR_INVALID_STATE" &&
                err?.message !== "Invalid state: Controller is already closed"
              ) {
                throw err;
              }
            }
            return;
          }

          const v2 = convertToV2({ version: 1, data: update as UpdateV1 });
          pendingUpdates.push(v2);
          if (batchTimer === null) {
            batchTimer = setTimeout(() => {
              batchTimer = null;
              void flushBatch(controller);
            }, updateBatchIntervalMs);
          }
        });
        onDestroy = ydoc.on("destroy", async () => {
          if (isDestroyed) {
            return;
          }
          isDestroyed = true;
          await flushBatch(controller);
          if (handler.destroy) {
            await handler.destroy();
          }
          controller.close();
        });
        onAwarenessUpdate = async (_clients: any, origin: any) => {
          if (origin === getSyncTransactionOrigin(ydoc) || isDestroyed) {
            return;
          }
          const update = encodeAwarenessUpdate(awareness, [
            awareness.clientID,
          ]) as AwarenessUpdateMessage;
          controller.enqueue(await handler.onAwarenessUpdate(update));
        };

        awareness.on("update", onAwarenessUpdate);
        onAwarenessDestroy = async () => {
          if (isDestroyed) {
            return;
          }
          isDestroyed = true;
          await flushBatch(controller);
          if (handler.destroy) {
            await handler.destroy();
          }
          controller.close();
        };
        awareness.on("destroy", onAwarenessDestroy);

        onMessage = (message) => {
          controller.enqueue(message);
        };
        observer.on("message", onMessage);
      },
      cancel() {
        isDestroyed = true;
        clearBatchTimer();
        pendingUpdates = [];
        ydoc.off("update", onUpdate);
        ydoc.off("destroy", onDestroy);
        awareness.off("update", onAwarenessUpdate);
        awareness.off("destroy", onAwarenessDestroy);
        observer.off("message", onMessage);
      },
    }),
  };
}

/**
 * Makes a {@link Sink} from a {@link Y.Doc} and a document name
 */
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
      const diff = Y.encodeStateAsUpdate(ydoc, stateVector);
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
        Y.applyUpdate(ydoc, decoded.structureUpdate, getSyncTransactionOrigin(ydoc));
      }
    },
    async handleUpdate(update) {
      const decoded = decodeContentEncryptedPayload(update.data as EncryptedUpdatePayload);
      if (decoded.structureUpdate.length > 0) {
        Y.applyUpdate(ydoc, decoded.structureUpdate, getSyncTransactionOrigin(ydoc));
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

  return {
    synced: new Promise((resolve, reject) => {
      onSynced = (success: boolean) => {
        if (success) {
          resolve();
        } else {
          reject(new Error("YDoc cancelled"));
        }
      };
    }),
    ydoc,
    awareness,
    writable: new WritableStream({
      async write(chunk, controller) {
        try {
          // For doc/awareness messages, ensure they target this document and are
          // not local-only. Non-doc/awareness messages (e.g. file messages)
          // bypass this filter so higher-level transports can still use the
          // same underlying transport.
          if (
            (chunk.type === "doc" || chunk.type === "awareness") &&
            (chunk.document !== document || chunk.context.clientId === "local")
          ) {
            return;
          }
          if (ydoc.isDestroyed) {
            controller.error(new Error("YDoc is destroyed"));
            return;
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
                  // This should be unreachable due to type checking
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
                  // Only resolve synced promise when sync-done is received
                  onSynced(true);
                  onSynced = () => {};
                  break;
                }
                case "auth-message": {
                  controller.error(new Error(chunk.payload.reason));
                  break;
                }
                default: {
                  // This should be unreachable due to type checking
                  const _exhaustive: never = chunk.payload;
                  throw new Error("Invalid chunk.payload.type", {
                    cause: { chunk: _exhaustive },
                  });
                }
              }
              break;
            }
            case "rpc": {
              // RPC messages are handled by the RPC client and RPC handlers,
              // not the Y.doc transport. They should NOT be passed through to
              // the readable stream, as that would cause them to be re-sent.
              break;
            }
            case "ack": {
              // ACK messages are handled by the connection layer,
              // not the Y.doc transport.
              break;
            }
            case "presence": {
              // Presence (client join/leave) messages are handled by the
              // provider, not the Y.doc transport.
              break;
            }
            default: {
              // Exhaustive check for message types - all types should be handled above
              const _exhaustive: never = chunk;
              void _exhaustive;
              break;
            }
          }
        } catch (err) {
          onSynced(false);
          onSynced = () => {};
          controller.error(err);
        }
      },
      close() {
        onSynced(false);
        onSynced = () => {};
      },
    }),
  };
}

/**
 * Makes a {@link Transport} from a {@link Y.Doc} and a document name
 */
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
  /**
   * An observer which can inject messages into the source stream.
   */
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
