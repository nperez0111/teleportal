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
  type Update,
  type Sink,
  type Source,
  type Transport,
  Observable,
} from "teleportal";
import { compose } from "teleportal/transports";

export function getSyncTransactionOrigin(ydoc: Y.Doc) {
  return ydoc.clientID + "-sync";
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
}: {
  ydoc: Y.Doc;
  document: string;
  awareness?: Awareness;
  observer?: Observable<{
    message: (message: Message) => void;
  }>;
}): Source<
  ClientContext,
  {
    ydoc: Y.Doc;
    awareness: Awareness;
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
    readable: new ReadableStream({
      start(controller) {
        onUpdate = ydoc.on("updateV2", (update, origin) => {
          if (origin === getSyncTransactionOrigin(ydoc) || isDestroyed) {
            return;
          }
          controller.enqueue(
            new DocMessage(
              document,
              {
                type: "update",
                update: update as Update,
              },
              {
                clientId: "local",
              },
            ),
          );
        });
        onDestroy = ydoc.on("destroy", () => {
          if (isDestroyed) {
            return;
          }
          isDestroyed = true;
          controller.close();
        });
        onAwarenessUpdate = (_clients: any, origin: any) => {
          if (origin === getSyncTransactionOrigin(ydoc) || isDestroyed) {
            return;
          }
          controller.enqueue(
            new AwarenessMessage(
              document,
              {
                type: "awareness-update",
                update: encodeAwarenessUpdate(awareness, [
                  awareness.clientID,
                ]) as AwarenessUpdateMessage,
              },
              {
                clientId: "local",
              },
            ),
          );
        };

        awareness.on("update", onAwarenessUpdate);
        onAwarenessDestroy = () => {
          if (isDestroyed) {
            return;
          }
          isDestroyed = true;
          controller.close();
        };
        awareness.on("destroy", onAwarenessDestroy);

        onMessage = (message) => {
          controller.enqueue(message);
        };
        observer.on("message", onMessage);
      },
      cancel() {
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
}: {
  ydoc: Y.Doc;
  document: string;
  awareness?: Awareness;
  observer?: Observable<{
    message: (message: Message) => void;
  }>;
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
      write(chunk, controller) {
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
                  applyAwarenessUpdate(
                    awareness,
                    chunk.payload.update,
                    getSyncTransactionOrigin(ydoc),
                  );
                  break;
                }
                case "awareness-request": {
                  observer.call(
                    "message",
                    new AwarenessMessage(
                      document,
                      {
                        type: "awareness-update",
                        update: encodeAwarenessUpdate(awareness, [
                          awareness.clientID,
                        ]) as AwarenessUpdateMessage,
                      },
                      {
                        clientId: "local",
                      },
                    ),
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
                    new DocMessage(
                      document,
                      {
                        type: "sync-step-2",
                        update: Y.diffUpdateV2(
                          Y.encodeStateAsUpdateV2(ydoc),
                          chunk.payload.sv,
                        ) as Update,
                      },
                      {
                        clientId: "local",
                      },
                    ),
                  );
                  break;
                }
                case "update":
                case "sync-step-2":
                  Y.applyUpdateV2(
                    ydoc,
                    chunk.payload.update,
                    getSyncTransactionOrigin(ydoc),
                  );
                  break;
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
