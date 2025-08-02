import { ClientContext, Message, Observable, type Transport } from "teleportal";
import { Awareness } from "y-protocols/awareness.js";
import * as Y from "yjs";
import { compose } from "../utils";
import { getYDocSink, getYDocSource } from "../ydoc";
import { EncryptionClient } from "./client";

/**
 * Wraps a transport in encryption, encrypting all document messages that are sent through the transport.
 */
export function getEncryptedTransport(handler: EncryptionClient): Transport<
  ClientContext,
  {
    ydoc: Y.Doc;
    awareness: Awareness;
    synced: Promise<void>;
    handler: EncryptionClient;
  }
> {
  const observer = new Observable<{
    message: (message: Message) => void;
  }>();

  const source = getYDocSource({
    ydoc: handler.ydoc,
    document: handler.document,
    awareness: handler.awareness,
    observer,
    handler,
  });
  const sink = getYDocSink({
    ydoc: handler.ydoc,
    document: handler.document,
    awareness: handler.awareness,
    observer,
    handler,
  });

  const transport = compose(source, sink);

  return {
    ...transport,
    handler,
  };
}
