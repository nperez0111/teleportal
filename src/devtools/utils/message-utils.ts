import { decoding } from "lib0";
import { toBase64 } from "lib0/buffer.js";
import {
  DocMessage,
  SyncStep2Update,
  type Message,
  type RawReceivedMessage,
} from "teleportal";
import { decryptUpdate } from "teleportal/encryption-key";
import {
  decodeEncryptedUpdate,
  decodeFromStateVector,
  decodeFromSyncStep2,
} from "teleportal/protocol/encryption";
import { Provider } from "teleportal/providers";
import * as Y from "yjs";

export type MessageType = Message | RawReceivedMessage;

function getDocId(message: { document?: string | null }): string {
  return message.document ?? "";
}

export function getMessageTypeLabel(message: MessageType): string {
  if (message.type === "doc") {
    return message.payload.type;
  }
  if (message.type === "awareness") {
    return message.payload.type === "awareness-update"
      ? "awareness-update"
      : "awareness-request";
  }
  if (message.type === "ack") {
    return "ack";
  }
  if (message.type === "rpc") {
    // Include request type (request/response/stream) for better clarity
    const requestType = message.requestType;
    if (requestType === "response") {
      return `${message.rpcMethod}`;
    }
    if (requestType === "stream") {
      return `${message.rpcMethod} (part)`;
    }
    return `${message.rpcMethod}`;
  }
  return "unknown";
}

export function getMessageTypeColor(message: MessageType): string {
  // Check message type directly for proper color mapping
  if (message.type === "rpc") {
    // Different colors for different RPC request types
    const requestType = message.requestType;
    if (requestType === "response") return "devtools-bg-indigo-500";
    if (requestType === "stream") return "devtools-bg-indigo-400";
    return "devtools-bg-indigo-600"; // request
  }

  if (message.type === "ack") return "devtools-bg-gray-500";

  const type = getMessageTypeLabel(message);

  // Document message types
  if (type === "sync-step-1") return "devtools-bg-blue-500";
  if (type === "sync-step-2") return "devtools-bg-blue-600";
  if (type === "update") return "devtools-bg-green-500";
  if (type === "sync-done") return "devtools-bg-green-600";
  if (type === "auth-message") return "devtools-bg-red-500";

  // Awareness
  if (type === "awareness-update") return "devtools-bg-yellow-500";
  if (type === "awareness-request") return "devtools-bg-yellow-600";

  return "devtools-bg-gray-400";
}

function mapToJSON(map: Map<any, any>): Record<any, any> {
  return [...map.entries()].reduce(
    (acc, [key, value]) => {
      acc[key] = value;
      return acc;
    },
    {} as Record<any, any>,
  );
}

function itemToJSON(item: Y.Item): Record<any, any> {
  return {
    id: item.id,
    content: item.content.getContent(),
    length: item.content.getLength(),
    countable: item.countable,
    deleted: item.deleted,
    right: item.right ? itemToJSON(item.right) : null,
    left: item.left ? itemToJSON(item.left) : null,
    parent: item.parent
      ? item.parent instanceof Y.Item
        ? itemToJSON(item.parent)
        : item.parent
      : null,
    parentSub: item.parentSub,
    origin: item.origin,
    rightOrigin: item.rightOrigin,
    redone: item.redone,
    keep: item.keep,
    lastId: item.lastId,
  };
}

export async function formatMessagePayload(
  message: MessageType,
  provider: Provider,
): Promise<string | null> {
  switch (message.type) {
    case "ack": {
      return `ACK(id: ${message.id}, acknowledged: ${message.payload.messageId})`;
    }
    case "awareness": {
      switch (message.payload.type) {
        case "awareness-update": {
          let update = message.payload.update;
          if (message.encrypted) {
            if (!provider.encryptionKey) {
              // bail, content is encrypted
              return toBase64(message.payload.update);
            }
            update = (await decryptUpdate(
              provider.encryptionKey,
              update,
            )) as any;
          }

          const decoder = decoding.createDecoder(update);
          const len = decoding.readVarUint(decoder);
          const clients = [];
          for (let i = 0; i < len; i++) {
            const clientID = decoding.readVarUint(decoder);
            const clock = decoding.readVarUint(decoder);
            const state = JSON.parse(decoding.readVarString(decoder));
            clients.push({ clientID, clock, state });
          }

          return JSON.stringify(clients, null, 2);
        }
        case "awareness-request": {
          return null;
        }
      }
    }
    case "doc": {
      switch (message.payload.type) {
        case "sync-step-1": {
          let stateVector = message.payload.sv;
          if (message.encrypted) {
            const decodedStateVector = decodeFromStateVector(stateVector);
            return JSON.stringify(decodedStateVector, null, 2);
          }
          return JSON.stringify(Y.decodeStateVector(stateVector), null, 2);
        }
        case "sync-step-2": {
          if (message.encrypted) {
            const decoded = decodeFromSyncStep2(message.payload.update);
            const items: string[] = [];
            if (decoded.snapshot) {
              if (!provider.encryptionKey) {
                items.push(toBase64(decoded.snapshot.payload));
              } else {
                const decrypted = await decryptUpdate(
                  provider.encryptionKey,
                  decoded.snapshot.payload,
                );
                const docMsg = new DocMessage(
                  getDocId(message),
                  {
                    type: "sync-step-2",
                    update: decrypted as SyncStep2Update,
                  },
                  message.context,
                  false,
                );
                const formatted = await formatMessagePayload(
                  docMsg as MessageType,
                  provider,
                );
                if (formatted != null) items.push(formatted);
              }
            }
            return Promise.all(
              decoded.updates.map(async (val) => {
                if (!provider.encryptionKey) {
                  // bail, content is encrypted & we have no key
                  return toBase64(val.payload);
                }
                const decrypted = await decryptUpdate(
                  provider.encryptionKey,
                  val.payload,
                );

                return formatMessagePayload(
                  new DocMessage(
                    getDocId(message),
                    {
                      type: "sync-step-2",
                      update: decrypted as SyncStep2Update,
                    },
                    message.context,
                    false,
                  ),
                  provider,
                );
              }),
            ).then((res) => {
              const combined = items.concat(
                res.filter((s): s is string => s != null),
              );
              if (combined.length === 0) {
                return `[]`;
              }
              return combined.join("\n");
            });
          }
        }
        case "update": {
          if (message.encrypted && message.payload.type === "update") {
            const decoded = decodeEncryptedUpdate(message.payload.update);
            if (decoded.type === "snapshot") {
              if (!provider.encryptionKey) {
                return `snapshot:${decoded.snapshot.id} ${toBase64(
                  decoded.snapshot.payload,
                )}`;
              }
              const decrypted = await decryptUpdate(
                provider.encryptionKey,
                decoded.snapshot.payload,
              );
              const formatted = await formatMessagePayload(
                new DocMessage(
                  getDocId(message),
                  {
                    type: "sync-step-2",
                    update: decrypted as SyncStep2Update,
                  },
                  message.context,
                  false,
                ),
                provider,
              );
              return `snapshot:${decoded.snapshot.id}\n${formatted}`;
            }

            return Promise.all(
              decoded.updates.map(async (val) => {
                if (!provider.encryptionKey) {
                  // bail, content is encrypted & we have no key
                  return toBase64(val.payload);
                }
                const decrypted = await decryptUpdate(
                  provider.encryptionKey,
                  val.payload,
                );

                return formatMessagePayload(
                  new DocMessage(
                    getDocId(message),
                    {
                      type: "sync-step-2",
                      update: decrypted as SyncStep2Update,
                    },
                    message.context,
                    false,
                  ),
                  provider,
                );
              }),
            ).then((res) => {
              if (res.length === 0) {
                return `[]`;
              }
              return res.join("\n");
            });
          }
        }
        case "update":
        case "sync-step-2": {
          let update = message.payload.update;
          if (message.encrypted) {
            // should be handled above
            return toBase64(update);
          }

          const meta = Y.parseUpdateMetaV2(update);
          const decodedUpdate = Y.decodeUpdateV2(update);

          // TODO ask Kevin later about how to do this
          // we known the state vector, before and after the update
          // can we derive the before and after docs?
          // const beforeStateVector = Y.decodeStateVector(
          //   Y.encodeStateVector(doc),
          // );
          // const afterStateVector = Y.decodeStateVector(
          //   Y.encodeStateVector(doc),
          // );
          // console.log("beforeStateVector", mapToJSON(beforeStateVector));
          // console.log("afterStateVector", mapToJSON(afterStateVector));

          // meta.from.forEach((value, key) => {
          //   console.log("setting", key, value);
          //   beforeStateVector.set(key, value);
          // });
          // meta.to.forEach((value, key) => {
          //   console.log("setting", key, value);
          //   afterStateVector.set(key, value);
          // });
          // console.log("beforeStateVector, after", mapToJSON(beforeStateVector));
          // console.log("afterStateVector, after", mapToJSON(afterStateVector));

          // const beforeDoc = Y.createDocFromSnapshot(
          //   doc,
          //   new Y.Snapshot(decodedUpdate.ds, beforeStateVector),
          // );
          // const afterDoc = Y.createDocFromSnapshot(
          //   doc,
          //   new Y.Snapshot(decodedUpdate.ds, afterStateVector),
          // );

          return JSON.stringify(
            {
              update: {
                structs: decodedUpdate.structs.map((struct) => {
                  switch (true) {
                    case struct instanceof Y.GC: {
                      return {
                        type: "gc",
                        id: struct.id,
                        deleted: struct.deleted,
                      };
                    }
                    case struct instanceof Y.Item: {
                      return itemToJSON(struct);
                    }
                    case struct instanceof Y.Skip: {
                      return {
                        type: "skip",
                        id: struct.id,
                        deleted: struct.deleted,
                        length: struct.length,
                      };
                    }
                    default: {
                      return "unknown struct";
                    }
                  }
                }),
                ds: {
                  clients: mapToJSON(decodedUpdate.ds.clients),
                },
              },
              stateVector: mapToJSON(
                Y.decodeStateVector(Y.encodeStateVectorFromUpdateV2(update)),
              ),
              meta: {
                from: mapToJSON(meta.from),
                to: mapToJSON(meta.to),
              },
            },
            null,
            2,
          );
        }
        case "sync-done": {
          return null;
        }
        case "auth-message": {
          return JSON.stringify(message.payload, null, 2);
        }
        default: {
          return null;
        }
      }
    }
    case "rpc": {
      return JSON.stringify(message.payload, null, 2);
    }
    default: {
      // @ts-expect-error - this should be unreachable due to type checking
      throw new Error(`Unknown message type: ${message.type}`);
    }
  }
}

export function isDocumentMessage(message: MessageType): boolean {
  return message.type === "doc";
}

export function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString();
}

export function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (seconds < 60) return `${seconds}s ago`;
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return new Date(timestamp).toLocaleDateString();
}
