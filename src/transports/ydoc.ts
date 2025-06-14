import {
  applyAwarenessUpdate,
  Awareness,
  encodeAwarenessUpdate,
} from "y-protocols/awareness";
import * as Y from "yjs";

import {
  type ClientContext,
  compose,
  toBinaryTransport,
  YBinaryTransport,
  type YSink,
  type YSource,
  type YTransport,
} from "../base";
import {
  AwarenessMessage,
  type AwarenessUpdateMessage,
  DocMessage,
  type Update,
} from "../protocol";
import { withLogger } from "./logger";

export function getSyncTransactionOrigin(ydoc: Y.Doc) {
  return ydoc.clientID + "-sync";
}

/**
 * Makes a {@link YSource} from a {@link Y.Doc} and a document name
 */
export function getSource({
  ydoc,
  document,
  awareness = new Awareness(ydoc),
}: {
  ydoc: Y.Doc;
  document: string;
  awareness?: Awareness;
}): YSource<ClientContext, { ydoc: Y.Doc; awareness: Awareness }> {
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
export function getSink({
  ydoc,
  document,
  awareness = new Awareness(ydoc),
}: {
  ydoc: Y.Doc;
  document: string;
  awareness?: Awareness;
}): YSink<
  ClientContext,
  {
    ydoc: Y.Doc;
    awareness: Awareness;
  }
> {
  return {
    ydoc,
    awareness,
    writable: new WritableStream({
      write(chunk, controller) {
        if (chunk.document !== document || chunk.context.clientId === "local") {
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
                break;
            }
          }
        }
      },
    }),
  };
}

/**
 * Makes a {@link YTransport} from a {@link Y.Doc} and a document name
 */
export function getTransport({
  ydoc,
  document,
  awareness = new Awareness(ydoc),
}: {
  ydoc: Y.Doc;
  document: string;
  awareness?: Awareness;
}): YTransport<ClientContext, { ydoc: Y.Doc; awareness: Awareness }> {
  return compose(
    getSource({ ydoc, awareness, document }),
    getSink({ ydoc, awareness, document }),
  );
}

export function getYDocTransport({
  ydoc,
  document,
  awareness = new Awareness(ydoc),
  debug = false,
}: {
  ydoc: Y.Doc;
  document: string;
  awareness?: Awareness;
  debug?: boolean;
}): YBinaryTransport<{ ydoc: Y.Doc; awareness: Awareness }> {
  let transport = getTransport({ ydoc, document, awareness });

  if (debug) {
    transport = withLogger(transport);
  }

  return toBinaryTransport(transport, {
    clientId: "remote",
  });
}
