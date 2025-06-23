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
  compose,
  DocMessage,
  StateVector,
  type Update,
  type YSink,
  type YSource,
  type YTransport,
} from "match-maker";

export function getSyncTransactionOrigin(ydoc: Y.Doc) {
  return ydoc.clientID + "-sync";
}

/**
 * Makes a {@link YSource} from a {@link Y.Doc} and a document name
 */
export function getYDocSource({
  ydoc,
  document,
  awareness = new Awareness(ydoc),
  asClient = true,
}: {
  ydoc: Y.Doc;
  document: string;
  awareness?: Awareness;
  asClient?: boolean;
}): YSource<
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
  let isDestroyed = false;

  return {
    ydoc,
    awareness,
    readable: new ReadableStream({
      start(controller) {
        if (asClient) {
          // Only open with a sync-step-1 if we're a client
          controller.enqueue(
            new DocMessage(document, {
              type: "sync-step-1",
              sv: Y.encodeStateVectorFromUpdateV2(
                Y.encodeStateAsUpdateV2(ydoc),
              ) as StateVector,
            }),
          );
        }
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
        onAwarenessUpdate = (
          {
            added,
            updated,
            removed,
          }: { added: number[]; updated: number[]; removed: number[] },
          origin: any,
        ) => {
          if (origin === getSyncTransactionOrigin(ydoc) || isDestroyed) {
            return;
          }
          const changedClients = added.concat(updated).concat(removed);
          controller.enqueue(
            new AwarenessMessage(
              document,
              {
                type: "awareness-update",
                update: encodeAwarenessUpdate(
                  awareness,
                  // TODO each client should only send it's own awareness updates
                  changedClients,
                ) as AwarenessUpdateMessage,
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
      },
      cancel() {
        ydoc.off("updateV2", onUpdate);
        ydoc.off("destroy", onDestroy);
        awareness.off("update", onAwarenessUpdate);
        awareness.off("destroy", onAwarenessDestroy);
      },
    }),
  };
}

/**
 * Makes a {@link YSink} from a {@link Y.Doc} and a document name
 */
export function getYDocSink({
  ydoc,
  document,
  awareness = new Awareness(ydoc),
}: {
  ydoc: Y.Doc;
  document: string;
  awareness?: Awareness;
  asClient?: boolean;
}): YSink<
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
              applyAwarenessUpdate(
                awareness,
                chunk.payload.update,
                getSyncTransactionOrigin(ydoc),
              );
              break;
            }
            case "doc": {
              switch (chunk.payload.type) {
                case "update":
                case "sync-step-2":
                  Y.applyUpdateV2(
                    ydoc,
                    chunk.payload.update,
                    getSyncTransactionOrigin(ydoc),
                  );
                  onSynced(true);
                  onSynced = () => {};
                  break;
                case "auth-message": {
                  controller.error(new Error(chunk.payload.reason));
                  break;
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
 * Makes a {@link YTransport} from a {@link Y.Doc} and a document name
 */
export function getYTransportFromYDoc({
  ydoc,
  document,
  awareness = new Awareness(ydoc),
  asClient = true,
}: {
  ydoc: Y.Doc;
  document: string;
  awareness?: Awareness;
  asClient?: boolean;
}): YTransport<
  ClientContext,
  {
    ydoc: Y.Doc;
    awareness: Awareness;
    synced: Promise<void>;
  }
> {
  return compose(
    getYDocSource({ ydoc, awareness, document, asClient }),
    getYDocSink({ ydoc, awareness, document, asClient }),
  );
}
