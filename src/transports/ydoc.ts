import {
  applyAwarenessUpdate,
  Awareness,
  encodeAwarenessUpdate,
} from "y-protocols/awareness";
import * as Y from "yjs";

import { ClientContext, compose, YSink, YSource, YTransport } from "../base";
import {
  AwarenessMessage,
  AwarenessUpdateMessage,
  DocMessage,
  encodeDocStep,
  Update,
} from "../protocol";

export function getSyncTransactionOrigin(ydoc: Y.Doc) {
  return ydoc.clientID + "-sync";
}

/**
 * Makes a {@link YSource} from a {@link Y.Doc} and a document name
 */
export function getSource<Context extends ClientContext>({
  ydoc,
  document,
  awareness = new Awareness(ydoc),
  context = {
    clientId: String(ydoc.clientID),
  } as Context,
}: {
  ydoc: Y.Doc;
  document: string;
  awareness?: Awareness;
  context?: Context;
}): YSource<Context, { ydoc: Y.Doc; awareness: Awareness }> {
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
              encodeDocStep("update", update as Update),
              context,
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
              encodeAwarenessUpdate(
                awareness,
                changedClients,
              ) as AwarenessUpdateMessage,
              context,
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
export function getSink<Context extends ClientContext>({
  ydoc,
  document,
  awareness = new Awareness(ydoc),
  context = {
    clientId: String(ydoc.clientID),
  } as Context,
}: {
  ydoc: Y.Doc;
  document: string;
  awareness?: Awareness;
  context?: Context;
}): YSink<
  Context,
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
        if (
          chunk.document !== document ||
          chunk.context.clientId === context.clientId
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
              chunk.update,
              getSyncTransactionOrigin(ydoc),
            );
            break;
          }
          case "doc": {
            switch (chunk.decoded.type) {
              case "update":
              case "sync-step-2":
                Y.applyUpdateV2(
                  ydoc,
                  chunk.decoded.payload,
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
export function getTransport<Context extends ClientContext>({
  ydoc,
  document,
  awareness = new Awareness(ydoc),
  context = {
    clientId: String(ydoc.clientID),
  } as Context,
}: {
  ydoc: Y.Doc;
  document: string;
  awareness?: Awareness;
  context?: Context;
}): YTransport<Context, { ydoc: Y.Doc; awareness: Awareness }> {
  return compose(
    getSource<Context>({ ydoc, awareness, document, context }),
    getSink<Context>({ ydoc, awareness, document }),
  );
}
