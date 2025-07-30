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
export function getYDocSource({
  ydoc,
  document,
  awareness = new Awareness(ydoc),
  observer = new Observable<{
    message: (message: Message) => void;
  }>(),
  client = {
    async onUpdate(update) {
      return new DocMessage(
        document,
        {
          type: "update",
          update: update as Update,
        },
        {
          clientId: "local",
        },
      );
    },
    async onAwarenessUpdate(update) {
      return new AwarenessMessage(
        document,
        {
          type: "awareness-update",
          update: update as AwarenessUpdateMessage,
        },
        {
          clientId: "local",
        },
      );
    },
    async start() {
      return new DocMessage(
        document,
        {
          type: "sync-step-1",
          sv: Y.encodeStateVector(ydoc) as StateVector,
        },
        {
          clientId: "local",
        },
      );
    },
  },
}: {
  ydoc: Y.Doc;
  document: string;
  awareness?: Awareness;
  observer?: Observable<{
    message: (message: Message) => void;
  }>;
  client?: YDocSourceHandler;
}): Source<
  ClientContext,
  {
    ydoc: Y.Doc;
    awareness: Awareness;
    client: YDocSourceHandler;
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
    client,
    readable: new ReadableStream({
      async start(controller) {
        onUpdate = ydoc.on("updateV2", async (update, origin) => {
          if (origin === getSyncTransactionOrigin(ydoc) || isDestroyed) {
            return;
          }
          controller.enqueue(await client.onUpdate(update as Update));
        });
        onDestroy = ydoc.on("destroy", async () => {
          if (isDestroyed) {
            return;
          }
          isDestroyed = true;
          if (client.destroy) {
            await client.destroy();
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
          controller.enqueue(await client.onAwarenessUpdate(update));
        };

        awareness.on("update", onAwarenessUpdate);
        onAwarenessDestroy = async () => {
          if (isDestroyed) {
            return;
          }
          isDestroyed = true;
          if (client.destroy) {
            await client.destroy();
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
export function getYDocSink({
  ydoc,
  document,
  awareness = new Awareness(ydoc),
  observer = new Observable<{
    message: (message: Message) => void;
  }>(),
  client = {
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
        {
          clientId: "local",
        },
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
        {
          clientId: "local",
        },
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
  ydoc: Y.Doc;
  document: string;
  awareness?: Awareness;
  observer?: Observable<{
    message: (message: Message) => void;
  }>;
  client?: YDocSinkHandler;
}): Sink<
  ClientContext,
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
          if (
            chunk.document !== document ||
            chunk.context.clientId === "local"
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
                  client.handleAwarenessUpdate(chunk.payload.update);
                  break;
                }
                case "awareness-request": {
                  const update = encodeAwarenessUpdate(awareness, [
                    awareness.clientID,
                  ]) as AwarenessUpdateMessage;
                  observer.call(
                    "message",
                    await client.handleAwarenessRequest(update),
                  );
                  break;
                }
                default: {
                  // @ts-expect-error - this should be unreachable due to type checking
                  chunk.payload.type;
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
                  observer.call(
                    "message",
                    await client.handleSyncStep1(chunk.payload.sv),
                  );
                  break;
                }
                case "sync-step-2": {
                  await client.handleSyncStep2(chunk.payload.update);
                  break;
                }
                case "update": {
                  await client.handleUpdate(chunk.payload.update);
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
                  // @ts-expect-error - this should be unreachable due to type checking
                  chunk.payload.type;
                  throw new Error("Invalid chunk.payload.type", {
                    cause: { chunk },
                  });
                }
              }
            }
          }
        } catch (e) {
          console.error(e);
          onSynced(false);
          onSynced = () => {};
          controller.error(e);
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
export function getYTransportFromYDoc({
  ydoc,
  document,
  awareness = new Awareness(ydoc),
}: {
  ydoc: Y.Doc;
  document: string;
  awareness?: Awareness;
}): Transport<
  ClientContext,
  {
    ydoc: Y.Doc;
    awareness: Awareness;
    synced: Promise<void>;
    client: Pick<YDocSourceHandler, "start">;
  }
> {
  // observer is used for cross communication between the source and sink
  const observer = new Observable<{
    message: (message: Message) => void;
  }>();

  return compose(
    getYDocSource({ ydoc, awareness, document, observer }),
    getYDocSink({ ydoc, awareness, document, observer }),
  );
}
