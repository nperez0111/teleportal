import { describe, expect, it } from "bun:test";
import { RpcMessage } from "teleportal/protocol";
import type { FileTransferProgress } from "teleportal/protocols/file";
import type { DevtoolsMessage } from "../types";
import { buildRpcGroups } from "./rpc-tracker";

let now = 1000;

function wrap(message: RpcMessage<any>, timestamp = (now += 10)): DevtoolsMessage {
  return {
    id: message.id,
    message,
    direction: "sent",
    timestamp,
    document: message.document,
    provider: null as any,
    connection: null,
  };
}

function request(method: string, payload: Record<string, unknown> = {}): RpcMessage<any> {
  return new RpcMessage("doc-1", { type: "success", payload }, method, "request", undefined);
}

function response(
  method: string,
  originalRequestId: string,
  payload: Record<string, unknown> = {},
): RpcMessage<any> {
  return new RpcMessage(
    "doc-1",
    { type: "success", payload },
    method,
    "response",
    originalRequestId,
  );
}

function errorResponse(
  method: string,
  originalRequestId: string,
  statusCode: number,
  details: string,
): RpcMessage<any> {
  return new RpcMessage(
    "doc-1",
    { type: "error", statusCode, details },
    method,
    "response",
    originalRequestId,
  );
}

function streamPart(
  method: string,
  originalRequestId: string,
  payload: Record<string, unknown>,
): RpcMessage<any> {
  return new RpcMessage("doc-1", { type: "success", payload }, method, "stream", originalRequestId);
}

describe("buildRpcGroups", () => {
  it("pairs a response to its request by originalRequestId and computes latency", () => {
    const req = request("listMilestones");
    const reqMsg = wrap(req, 1000);
    const resMsg = wrap(response("listMilestones", req.id, { milestones: [] }), 1034);

    const { groups, groupKeyByMessageId } = buildRpcGroups([reqMsg, resMsg]);

    expect(groups.size).toBe(1);
    const group = groups.get(req.id)!;
    expect(group.method).toBe("listMilestones");
    expect(group.status).toBe("success");
    expect(group.latencyMs).toBe(34);
    expect(group.request).toBe(reqMsg);
    expect(group.response).toBe(resMsg);
    expect(groupKeyByMessageId.get(resMsg.id)).toBe(req.id);
  });

  it("marks a lone request as pending", () => {
    const req = request("keysGet");
    const { groups } = buildRpcGroups([wrap(req)]);
    expect(groups.get(req.id)!.status).toBe("pending");
  });

  it("surfaces error responses with statusCode and details", () => {
    const req = request("keysGet");
    const { groups } = buildRpcGroups([
      wrap(req),
      wrap(errorResponse("keysGet", req.id, 403, "permission denied")),
    ]);
    const group = groups.get(req.id)!;
    expect(group.status).toBe("error");
    expect(group.statusCode).toBe(403);
    expect(group.errorDetails).toBe("permission denied");
  });

  it("pairs upload stream parts via the fileId alias and tracks chunk progress", () => {
    const req = request("fileUpload", {
      fileId: "file-abc",
      filename: "design.fig",
      size: 200,
      mimeType: "image/png",
      encrypted: false,
    });
    const reqMsg = wrap(req, 1000);
    const res = wrap(response("fileUpload", req.id, { fileId: "file-abc" }), 1010);
    // Upload streams reference the uploadId (fileId), not the request id.
    const part0 = wrap(
      streamPart("fileUpload", "file-abc", {
        fileId: "file-abc",
        chunkIndex: 0,
        totalChunks: 2,
        bytesUploaded: 100,
        encrypted: false,
      }),
      1020,
    );
    part0.ackedBy = { ackMessageId: "a", ackMessage: null as any, timestamp: 1025 };
    const part1 = wrap(
      streamPart("fileUpload", "file-abc", {
        fileId: "file-abc",
        chunkIndex: 1,
        totalChunks: 2,
        bytesUploaded: 200,
        encrypted: false,
      }),
      1030,
    );

    const { groups } = buildRpcGroups([reqMsg, res, part0, part1]);

    expect(groups.size).toBe(1);
    const group = groups.get(req.id)!;
    expect(group.parts.length).toBe(2);
    expect(group.transfer).toMatchObject({
      direction: "upload",
      fileId: "file-abc",
      filename: "design.fig",
      size: 200,
      chunksSeen: 2,
      chunksAcked: 1,
      totalChunks: 2,
      bytesTransferred: 200,
    });
    // Only 1 of 2 chunks acked → still streaming.
    expect(group.status).toBe("streaming");

    part1.ackedBy = { ackMessageId: "b", ackMessage: null as any, timestamp: 1040 };
    const done = buildRpcGroups([reqMsg, res, part0, part1]).groups.get(req.id)!;
    expect(done.transfer!.chunksAcked).toBe(2);
    expect(done.status).toBe("success");
  });

  it("completes a download when all chunks arrive and the response is present", () => {
    const req = request("fileDownload", { fileId: "file-xyz" });
    const reqMsg = wrap(req, 1000);
    const resMsg = wrap(
      response("fileDownload", req.id, {
        fileId: "file-xyz",
        filename: "photo.png",
        size: 128,
        mimeType: "image/png",
        totalChunks: 1,
      }),
      1010,
    );
    const partMsg = wrap(
      streamPart("fileDownload", req.id, {
        fileId: "file-xyz",
        chunkIndex: 0,
        totalChunks: 1,
        bytesUploaded: 128,
        encrypted: true,
      }),
      1020,
    );
    partMsg.direction = "received";

    const { groups } = buildRpcGroups([reqMsg, resMsg, partMsg]);
    const group = groups.get(req.id)!;
    expect(group.status).toBe("success");
    expect(group.transfer).toMatchObject({
      direction: "download",
      filename: "photo.png",
      chunksSeen: 1,
      totalChunks: 1,
      encrypted: true,
    });
  });

  it("groups orphan stream parts by originalRequestId without a visible request", () => {
    const a = wrap(streamPart("fileDownload", "gone-request", { fileId: "f", chunkIndex: 0 }));
    const b = wrap(streamPart("fileDownload", "gone-request", { fileId: "f", chunkIndex: 1 }));

    const { groups } = buildRpcGroups([a, b]);
    expect(groups.size).toBe(1);
    const group = [...groups.values()][0];
    expect(group.request).toBeNull();
    expect(group.parts.length).toBe(2);
  });

  it("overlays live transfer progress when chunk messages are not visible", () => {
    // Upload chunks never flow through the message pipeline — only the
    // request and response are visible. Progress arrives via the file
    // protocol's progress events, keyed by the request's fileId.
    const req = request("fileUpload", { fileId: "file-live", filename: "big.bin", size: 1000 });
    const reqMsg = wrap(req, 1000);
    const resMsg = wrap(response("fileUpload", req.id, { fileId: "file-live" }), 1010);

    const progress = new Map<string, FileTransferProgress>([
      [
        "file-live",
        {
          fileId: "file-live",
          document: "doc-1",
          direction: "upload",
          chunksTransferred: 3,
          totalChunks: 10,
          bytesTransferred: 300,
          status: "active",
        },
      ],
    ]);

    const active = buildRpcGroups([reqMsg, resMsg], progress).groups.get(req.id)!;
    expect(active.status).toBe("streaming");
    expect(active.transfer).toMatchObject({
      chunksAcked: 3,
      totalChunks: 10,
      bytesTransferred: 300,
    });

    progress.set("file-live", {
      ...progress.get("file-live")!,
      chunksTransferred: 10,
      bytesTransferred: 1000,
      status: "complete",
    });
    const done = buildRpcGroups([reqMsg, resMsg], progress).groups.get(req.id)!;
    expect(done.status).toBe("success");
    expect(done.transfer!.chunksAcked).toBe(10);

    progress.set("file-live", {
      ...progress.get("file-live")!,
      status: "error",
      error: "upload failed: 2 chunks unacknowledged",
    });
    const failed = buildRpcGroups([reqMsg, resMsg], progress).groups.get(req.id)!;
    expect(failed.status).toBe("error");
    expect(failed.errorDetails).toBe("upload failed: 2 chunks unacknowledged");
  });

  it("ignores live progress whose direction does not match the group", () => {
    const req = request("fileUpload", { fileId: "file-x", filename: "a.bin", size: 10 });
    const progress = new Map<string, FileTransferProgress>([
      [
        "file-x",
        {
          fileId: "file-x",
          document: "doc-1",
          direction: "download",
          chunksTransferred: 1,
          totalChunks: 1,
          bytesTransferred: 10,
          status: "complete",
        },
      ],
    ]);
    const group = buildRpcGroups([wrap(req)], progress).groups.get(req.id)!;
    expect(group.status).toBe("pending");
  });

  it("counts retransmitted chunks once", () => {
    const req = request("fileUpload", { fileId: "f2", filename: "a.bin", size: 10 });
    const p = (ts: number) =>
      wrap(
        streamPart("fileUpload", "f2", {
          fileId: "f2",
          chunkIndex: 0,
          totalChunks: 1,
          bytesUploaded: 10,
        }),
        ts,
      );
    const { groups } = buildRpcGroups([wrap(req, 1000), p(1010), p(1020)]);
    expect(groups.get(req.id)!.transfer!.chunksSeen).toBe(1);
  });
});
