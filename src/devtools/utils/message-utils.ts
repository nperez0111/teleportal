import { decoding } from "lib0";
import { toBase64 } from "teleportal/utils";
import {
  DocMessage,
  type SyncStep2UpdateV2,
  type Message,
  type RawReceivedMessage,
  type VersionedSyncStep2Update,
  type VersionedUpdate,
} from "teleportal";
import {
  decodeUpdateVersioned,
  encodeStateVectorFromVersionedUpdate,
  parseUpdateMetaVersioned,
} from "teleportal/protocol";
import { type ContentMap, type IdMap, decodeContentMap } from "teleportal/attribution";
import { decryptUpdate } from "teleportal/encryption-key";
import {
  decodeContentEncryptedPayload,
  decodeSidecar,
  mergeSidecars,
  restoreContent,
} from "teleportal/protocol/encryption";
import { Provider } from "teleportal/providers";
import type { EncodedContentMap } from "teleportal/storage";
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
    return message.payload.type === "awareness-update" ? "awareness-update" : "awareness-request";
  }
  if (message.type === "ack") {
    return "ack";
  }
  if (message.type === "presence") {
    return message.payload.type;
  }
  if (message.type === "rpc") {
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
  if (message.type === "rpc") {
    const requestType = message.requestType;
    if (requestType === "response") return "devtools-bg-indigo-500";
    if (requestType === "stream") return "devtools-bg-indigo-400";
    return "devtools-bg-indigo-600";
  }

  if (message.type === "ack") return "devtools-bg-gray-500";
  if (message.type === "presence") return "devtools-bg-purple-500";

  const type = getMessageTypeLabel(message);

  if (type === "sync-step-1") return "devtools-bg-blue-500";
  if (type === "sync-step-2") return "devtools-bg-blue-600";
  if (type === "update") return "devtools-bg-green-500";
  if (type === "sync-done") return "devtools-bg-green-600";
  if (type === "auth-message") return "devtools-bg-red-500";

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

function idMapToJSON(idMap: IdMap): Record<string, unknown[]> {
  const result: Record<string, unknown[]> = {};
  for (const [client, ranges] of idMap.clients.entries()) {
    result[String(client)] = ranges.getIds().map((range) => ({
      clock: range.clock,
      len: range.len,
      attrs: Object.fromEntries(range.attrs.map((a) => [a.name, a.val])),
    }));
  }
  return result;
}

function contentMapToJSON(contentMap: ContentMap) {
  return {
    inserts: idMapToJSON(contentMap.inserts),
    deletes: idMapToJSON(contentMap.deletes),
  };
}

function formatRpcPayload(message: MessageType & { type: "rpc" }): unknown {
  const { payload } = message;

  if (payload.type === "error") return payload;

  if (message.rpcMethod === "attributionGet" && message.requestType === "response") {
    const data = payload.payload as { contentMap: EncodedContentMap | null };
    if (!data.contentMap) return { ...payload, payload: { contentMap: null } };

    try {
      const decoded = decodeContentMap(data.contentMap);
      return { ...payload, payload: { contentMap: contentMapToJSON(decoded) } };
    } catch {
      return { ...payload, payload: { contentMap: toBase64(data.contentMap) } };
    }
  }

  return payload;
}

/**
 * Decrypts a content-encrypted doc payload into a plaintext V2 update by
 * decrypting the sidecars and restoring the content placeholders.
 */
export async function decryptContentPayload(
  data: Uint8Array,
  encryptionKey: CryptoKey,
): Promise<{
  update: VersionedSyncStep2Update;
  compaction: ReturnType<typeof decodeContentEncryptedPayload>["compaction"];
} | null> {
  try {
    const payload = decodeContentEncryptedPayload(data as any);
    const sidecars = [];
    for (const encrypted of payload.encryptedSidecars) {
      const sidecarBytes = await decryptUpdate(encryptionKey, encrypted);
      sidecars.push(decodeSidecar(sidecarBytes));
    }
    const v2 = restoreContent(payload.structureUpdate, mergeSidecars(sidecars));
    return {
      update: { version: 2, data: v2 as SyncStep2UpdateV2 } as VersionedSyncStep2Update,
      compaction: payload.compaction,
    };
  } catch {
    return null;
  }
}

async function formatEncryptedPayload(
  data: Uint8Array,
  message: MessageType,
  provider: Provider,
): Promise<string | null> {
  if (!provider.encryptionKey) {
    return toBase64(data);
  }

  const decrypted = await decryptContentPayload(data, provider.encryptionKey);
  if (!decrypted) {
    return toBase64(data);
  }

  const result = await formatMessagePayload(
    new DocMessage(
      getDocId(message),
      {
        type: "sync-step-2",
        update: decrypted.update as VersionedSyncStep2Update,
      },
      message.context,
      false,
    ),
    provider,
  );

  if (result && decrypted.compaction) {
    try {
      const parsed = JSON.parse(result);
      parsed.compaction = {
        sidecarBytes: decrypted.compaction.sidecar.length,
        index: decrypted.compaction.index,
        hash: toBase64(decrypted.compaction.hash),
        sourceHashes: decrypted.compaction.sourceHashes.map((h) => toBase64(h)),
      };
      return JSON.stringify(parsed, null, 2);
    } catch {
      return result;
    }
  }

  return result;
}

export function formatEncryptedDocEnvelope(data: Uint8Array): string | null {
  try {
    const payload = decodeContentEncryptedPayload(data as any);
    const envelope: Record<string, unknown> = {
      wireVersion: payload.wireVersion ?? 1,
      totalBytes: data.length,
      structureUpdate: {
        bytes: payload.structureUpdate.length,
        data: toBase64(payload.structureUpdate),
      },
      encryptedSidecars: payload.encryptedSidecars.map((s, i) => ({
        index: i,
        bytes: s.length,
        data: toBase64(s),
      })),
    };

    if (payload.compaction) {
      envelope.compaction = {
        sidecar: {
          bytes: payload.compaction.sidecar.length,
          data: toBase64(payload.compaction.sidecar),
        },
        index: payload.compaction.index,
        hash: toBase64(payload.compaction.hash),
        sourceHashes: payload.compaction.sourceHashes.map((h) => toBase64(h)),
      };
    }

    return JSON.stringify(envelope, null, 2);
  } catch {
    return toBase64(data);
  }
}

export function formatEncryptedAwarenessEnvelope(data: Uint8Array): string {
  return JSON.stringify(
    {
      totalBytes: data.length,
      data: toBase64(data),
    },
    null,
    2,
  );
}

export async function formatMessagePayload(
  message: MessageType,
  provider: Provider,
): Promise<string | null> {
  switch (message.type) {
    case "ack": {
      return `ACK(id: ${message.id}, acknowledged: ${message.payload.messageId})`;
    }
    case "presence": {
      return JSON.stringify(message.payload, null, 2);
    }
    case "awareness": {
      switch (message.payload.type) {
        case "awareness-update": {
          let update = message.payload.update;
          if (message.encrypted) {
            if (!provider.encryptionKey) {
              return toBase64(message.payload.update);
            }
            update = (await decryptUpdate(provider.encryptionKey, update)) as any;
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
          const stateVector = message.payload.sv;
          return JSON.stringify(mapToJSON(Y.decodeStateVector(stateVector)), null, 2);
        }
        case "update":
        case "sync-step-2": {
          if (message.encrypted) {
            return formatEncryptedPayload(
              message.payload.update.data as Uint8Array,
              message,
              provider,
            );
          }
          const versionedUpdate = message.payload.update as VersionedUpdate;

          const meta = parseUpdateMetaVersioned(versionedUpdate);
          const decodedUpdate = decodeUpdateVersioned(versionedUpdate);

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
                Y.decodeStateVector(encodeStateVectorFromVersionedUpdate(versionedUpdate)),
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
      return JSON.stringify(formatRpcPayload(message), null, 2);
    }
    default: {
      // @ts-expect-error - this should be unreachable due to type checking
      throw new Error(`Unknown message type: ${message.type}`);
    }
  }
}

export function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString();
}

export function formatLogEntry(msg: {
  message: MessageType;
  direction: "sent" | "received";
  timestamp: number;
  document: string | undefined;
  ackedBy?: { timestamp: number } | undefined;
}): string {
  const time = new Date(msg.timestamp).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  });
  const arrow = msg.direction === "sent" ? "CLIENT → SERVER" : "SERVER → CLIENT";
  const type = getMessageTypeLabel(msg.message);
  const doc = msg.document ? `doc: "${msg.document}"` : "doc: (none)";
  const encrypted = msg.message.encrypted ? "encrypted" : "plaintext";

  let ack = "";
  if (msg.ackedBy) {
    const latency = msg.ackedBy.timestamp - msg.timestamp;
    ack = ` | acked (${latency}ms)`;
  }

  return `[${time}] ${arrow} | ${type} | ${doc} | ${encrypted}${ack}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/**
 * Buckets an ACK round-trip against the 30s in-flight timeout:
 * fast (comfortably acked), slow (getting close), stalled (about to time out).
 */
export function getAckLatencyLevel(latencyMs: number): "fast" | "slow" | "stalled" {
  if (latencyMs < 3_000) return "fast";
  if (latencyMs < 15_000) return "slow";
  return "stalled";
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
