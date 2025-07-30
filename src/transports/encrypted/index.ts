import { ClientContext, Message, Observable, type Transport } from "teleportal";
import { Awareness } from "y-protocols/awareness.js";
import * as Y from "yjs";
import { compose } from "../utils";
import { getYDocSink, getYDocSource } from "../ydoc";
import { EncryptionClient } from "./client";

/**
 * Wraps a transport in encryption, encrypting all document messages that are sent through the transport.
 */
export function getEncryptedTransport(client: EncryptionClient): Transport<
  ClientContext,
  {
    ydoc: Y.Doc;
    awareness: Awareness;
    synced: Promise<void>;
    client: EncryptionClient;
  }
> {
  const observer = new Observable<{
    message: (message: Message) => void;
  }>();

  const source = getYDocSource({
    ydoc: client.ydoc,
    document: client.document,
    awareness: client.awareness,
    observer,
    client,
  });
  const sink = getYDocSink({
    ydoc: client.ydoc,
    document: client.document,
    awareness: client.awareness,
    observer,
    client,
  });

  const transport = compose(source, sink);

  return {
    ...transport,
    client,
  };
}
