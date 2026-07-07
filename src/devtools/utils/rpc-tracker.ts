import type { RpcMessage } from "teleportal";
import type { FileTransferProgress } from "teleportal/protocols/file";
import type { DevtoolsMessage } from "../types";

export type RpcGroupStatus = "pending" | "streaming" | "success" | "error";

/**
 * Summary of a chunked file transfer (fileUpload/fileDownload) derived from
 * the request/response payloads and the FilePartStream messages.
 */
export type FileTransferSummary = {
  direction: "upload" | "download";
  fileId?: string;
  filename?: string;
  size?: number;
  mimeType?: string;
  encrypted: boolean;
  /** Distinct chunk indexes observed in stream messages. */
  chunksSeen: number;
  /** Distinct chunk indexes with at least one acknowledged stream message. */
  chunksAcked: number;
  totalChunks?: number;
  /** Highest bytesUploaded value observed across stream parts. */
  bytesTransferred: number;
};

/**
 * A logical RPC call: the request, its streamed parts, and the response,
 * paired by `originalRequestId` (with fileId aliasing for file transfers,
 * whose upload streams reference the client-generated fileId instead of the
 * request message id).
 */
export type RpcGroup = {
  /** Request message id, or an orphan key when the request isn't visible. */
  key: string;
  method: string;
  document: string | undefined;
  request: DevtoolsMessage | null;
  response: DevtoolsMessage | null;
  /** Stream messages in arrival order. */
  parts: DevtoolsMessage[];
  status: RpcGroupStatus;
  statusCode?: number;
  errorDetails?: string;
  /** Request → response round-trip, when both are visible. */
  latencyMs?: number;
  /** Request → last activity. Meaningful for streaming calls. */
  durationMs?: number;
  transfer?: FileTransferSummary;
  /** Index of the oldest member in the source message array (position anchor). */
  firstIndex: number;
  lastTimestamp: number;
};

export type RpcGroupIndex = {
  /** Group key → group, in first-seen order. */
  groups: Map<string, RpcGroup>;
  /** Message id → group key, for every rpc message that joined a group. */
  groupKeyByMessageId: Map<string, string>;
};

const FILE_METHODS = new Set(["fileUpload", "fileDownload"]);

function isRpc(msg: DevtoolsMessage): boolean {
  return msg.message.type === "rpc";
}

function rpcOf(msg: DevtoolsMessage): RpcMessage<any> {
  return msg.message as RpcMessage<any>;
}

function successPayloadOf(rpc: RpcMessage<any>): Record<string, unknown> | null {
  if (rpc.payload.type !== "success") return null;
  const inner = rpc.payload.payload;
  return inner && typeof inner === "object" ? (inner as Record<string, unknown>) : null;
}

/**
 * Groups the rpc messages of a message list into logical calls.
 *
 * Pure derivation — call it again whenever the message list changes. The
 * cost is a single pass over the list, so recomputing per render is fine
 * for devtools-sized lists.
 *
 * Upload chunk messages never appear in the message list (streams stay off
 * the event pipeline for throughput), so `transferProgress` — live snapshots
 * from the file protocol's progress events, keyed by fileId — supplies the
 * chunk counts and completion state for file transfer groups.
 */
export function buildRpcGroups(
  messages: DevtoolsMessage[],
  transferProgress?: ReadonlyMap<string, FileTransferProgress>,
): RpcGroupIndex {
  const groups = new Map<string, RpcGroup>();
  const groupKeyByMessageId = new Map<string, string>();
  /** fileId → group key, for pairing file transfer streams to their request. */
  const aliases = new Map<string, string>();

  const resolveKey = (rpc: RpcMessage<any>): string | null => {
    const ref = rpc.originalRequestId;
    if (ref) {
      if (groups.has(ref)) return ref;
      const aliased = aliases.get(ref);
      if (aliased) return aliased;
    }
    // Streams carry the fileId in their payload — pair by that when the
    // originalRequestId doesn't resolve (e.g. download parts referencing
    // the request id of a request outside the retained window).
    const payload = successPayloadOf(rpc);
    const fileId = payload?.fileId;
    if (typeof fileId === "string") {
      const aliased = aliases.get(fileId);
      if (aliased) return aliased;
    }
    return null;
  };

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!isRpc(msg)) continue;
    const rpc = rpcOf(msg);

    if (rpc.requestType === "request") {
      const key = msg.id;
      const group: RpcGroup = {
        key,
        method: rpc.rpcMethod,
        document: msg.document,
        request: msg,
        response: null,
        parts: [],
        status: "pending",
        firstIndex: i,
        lastTimestamp: msg.timestamp,
      };
      groups.set(key, group);
      groupKeyByMessageId.set(msg.id, key);

      const payload = successPayloadOf(rpc);
      const fileId = payload?.fileId;
      if (typeof fileId === "string") {
        aliases.set(fileId, key);
      }
      continue;
    }

    let key = resolveKey(rpc);
    if (key === null) {
      // Orphan: keep parts of the same call together even without a request.
      key = `orphan:${rpc.originalRequestId ?? msg.id}`;
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          method: rpc.rpcMethod,
          document: msg.document,
          request: null,
          response: null,
          parts: [],
          status: "pending",
          firstIndex: i,
          lastTimestamp: msg.timestamp,
        });
      }
    }

    const group = groups.get(key)!;
    groupKeyByMessageId.set(msg.id, key);
    group.lastTimestamp = Math.max(group.lastTimestamp, msg.timestamp);

    if (rpc.requestType === "stream") {
      group.parts.push(msg);
    } else {
      group.response = msg;
    }
  }

  for (const group of groups.values()) {
    finalizeGroup(group, transferProgress);
  }

  return { groups, groupKeyByMessageId };
}

function finalizeGroup(
  group: RpcGroup,
  transferProgress?: ReadonlyMap<string, FileTransferProgress>,
): void {
  const response = group.response;
  const request = group.request;

  if (request && response) {
    group.latencyMs = Math.max(0, response.timestamp - request.timestamp);
  }
  if (request) {
    group.durationMs = Math.max(0, group.lastTimestamp - request.timestamp);
  }

  let live: FileTransferProgress | undefined;
  if (FILE_METHODS.has(group.method)) {
    group.transfer = buildTransferSummary(group);
    if (group.transfer.fileId) {
      const progress = transferProgress?.get(group.transfer.fileId);
      if (progress && progress.direction === group.transfer.direction) {
        live = progress;
        applyLiveProgress(group.transfer, progress);
      }
    }
  }

  if (response) {
    const rpc = rpcOf(response);
    if (rpc.payload.type === "error") {
      group.status = "error";
      group.statusCode = rpc.payload.statusCode;
      group.errorDetails = rpc.payload.details;
      return;
    }
  }

  if (live?.status === "error") {
    group.status = "error";
    group.errorDetails = live.error;
    return;
  }

  const transfer = group.transfer;
  if (transfer) {
    const done =
      live?.status === "complete" ||
      (transfer.totalChunks !== undefined &&
        (transfer.direction === "upload"
          ? transfer.chunksAcked >= transfer.totalChunks
          : response !== null && transfer.chunksSeen >= transfer.totalChunks));
    group.status = done ? "success" : response || group.parts.length > 0 ? "streaming" : "pending";
    return;
  }

  if (response) {
    group.status = "success";
  } else if (group.parts.length > 0) {
    group.status = "streaming";
  } else {
    group.status = "pending";
  }
}

function applyLiveProgress(transfer: FileTransferSummary, live: FileTransferProgress): void {
  const acked = Math.max(transfer.chunksAcked, live.chunksTransferred);
  transfer.chunksAcked = acked;
  transfer.chunksSeen = Math.max(transfer.chunksSeen, acked);
  transfer.totalChunks ??= live.totalChunks;
  transfer.bytesTransferred = Math.max(transfer.bytesTransferred, live.bytesTransferred);
}

function buildTransferSummary(group: RpcGroup): FileTransferSummary {
  const direction = group.method === "fileUpload" ? "upload" : "download";
  const summary: FileTransferSummary = {
    direction,
    encrypted: false,
    chunksSeen: 0,
    chunksAcked: 0,
    bytesTransferred: 0,
  };

  const meta = (payload: Record<string, unknown> | null) => {
    if (!payload) return;
    if (typeof payload.fileId === "string") summary.fileId = payload.fileId;
    if (typeof payload.filename === "string") summary.filename = payload.filename;
    if (typeof payload.size === "number") summary.size = payload.size;
    if (typeof payload.mimeType === "string") summary.mimeType = payload.mimeType;
    if (typeof payload.encrypted === "boolean") summary.encrypted = payload.encrypted;
    if (typeof payload.totalChunks === "number") summary.totalChunks = payload.totalChunks;
  };
  if (group.request) meta(successPayloadOf(rpcOf(group.request)));
  if (group.response) meta(successPayloadOf(rpcOf(group.response)));

  const seen = new Set<number>();
  const acked = new Set<number>();
  for (const part of group.parts) {
    const payload = successPayloadOf(rpcOf(part));
    if (!payload) continue;
    const chunkIndex = typeof payload.chunkIndex === "number" ? payload.chunkIndex : null;
    if (chunkIndex !== null) {
      seen.add(chunkIndex);
      if (part.ackedBy) acked.add(chunkIndex);
    }
    if (typeof payload.totalChunks === "number") summary.totalChunks = payload.totalChunks;
    if (typeof payload.bytesUploaded === "number") {
      summary.bytesTransferred = Math.max(summary.bytesTransferred, payload.bytesUploaded);
    }
    if (payload.encrypted === true) summary.encrypted = true;
  }
  summary.chunksSeen = seen.size;
  summary.chunksAcked = acked.size;
  return summary;
}

/**
 * Cheap change signature so list rows only re-render when a group's visible
 * state actually changed.
 */
export function rpcGroupSignature(group: RpcGroup): string {
  const t = group.transfer;
  return [
    group.status,
    group.statusCode ?? "",
    group.parts.length,
    group.response ? 1 : 0,
    group.latencyMs ?? "",
    t ? `${t.chunksSeen}/${t.chunksAcked}/${t.totalChunks ?? ""}/${t.bytesTransferred}` : "",
  ].join("|");
}
