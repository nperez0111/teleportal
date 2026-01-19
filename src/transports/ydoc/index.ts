import {
  applyAwarenessUpdate,
  Awareness,
  encodeAwarenessUpdate,
} from "y-protocols/awareness";
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
  type SyncStep2Update,
  type Transport,
  type Update,
} from "teleportal";
import { compose } from "teleportal/transports";

export function getSyncTransactionOrigin(ydoc: Y.Doc) {
  return ydoc.clientID + "-sync";
}

export interface YDocSourceHandler {
  onUpdate(update: Update): Promise<Message>;
  onAwarenessUpdate(update: AwarenessUpdateMessage): Promise<Message>;
  start(): Promise<Message>;
  destroy?: () => void;
}

export interface YDocSinkHandler {
  handleSyncStep1(stateVector: StateVector): Promise<DocMessage<ClientContext>>;
  handleSyncStep2(syncStep2: SyncStep2Update): Promise<void>;
  handleUpdate(update: Update): Promise<void>;
  handleAwarenessUpdate(update: AwarenessUpdateMessage): Promise<void>;
  handleAwarenessRequest(
    update: AwarenessUpdateMessage,
  ): Promise<AwarenessMessage<ClientContext>>;
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
  handler = {
    async onUpdate(update) {
      return new DocMessage(
        document,
        {
          type: "update",
          update: update as Update,
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

  return {
    ydoc,
    awareness,
    handler,
    readable: new ReadableStream({
      async start(controller) {
        onUpdate = ydoc.on("updateV2", async (update, origin) => {
          if (origin === getSyncTransactionOrigin(ydoc) || isDestroyed) {
            return;
          }
          try {
            controller.enqueue(await handler.onUpdate(update as Update));
          } catch (err: any) {
            // Stream may be closed, ignore the error
            if (
              err?.code !== "ERR_INVALID_STATE" &&
              err?.message !== "Invalid state: Controller is already closed"
            ) {
              throw err;
            }
          }
        });
        onDestroy = ydoc.on("destroy", async () => {
          if (isDestroyed) {
            return;
          }
          isDestroyed = true;
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
        ydoc.off("updateV2", onUpdate);
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
      return new DocMessage(
        document,
        {
          type: "sync-step-2",
          update: Y.diffUpdateV2(
            Y.encodeStateAsUpdateV2(ydoc),
            stateVector,
          ) as SyncStep2Update,
        },
        context,
      );
    },
    async handleSyncStep2(syncStep2) {
      Y.applyUpdateV2(ydoc, syncStep2, getSyncTransactionOrigin(ydoc));
    },
    async handleUpdate(update) {
      Y.applyUpdateV2(ydoc, update, getSyncTransactionOrigin(ydoc));
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
                  observer.call(
                    "message",
                    await handler.handleAwarenessRequest(update),
                  );
                  break;
                }
                default: {
                  // This should be unreachable due to type checking
                  const _exhaustive: never = chunk.payload;
                  _exhaustive;
                  throw new Error("Invalid chunk.payload.type", {
                    cause: { chunk },
                  });
                }
              }
              break;
            }
            case "doc": {
              switch (chunk.payload.type) {
                case "sync-step-1": {
                  const response = await handler.handleSyncStep1(
                    chunk.payload.sv,
                  );
                  observer.call("message", response);
                  break;
                }
                case "sync-step-2": {
                  await handler.handleSyncStep2(chunk.payload.update);
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
                  _exhaustive;
                  throw new Error("Invalid chunk.payload.type", {
                    cause: { chunk },
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
            default: {
              // Exhaustive check for message types - all types should be handled above
              const _exhaustive: never = chunk;
              _exhaustive;
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
