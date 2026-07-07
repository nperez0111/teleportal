import { describe, expect, it } from "bun:test";
import { CHUNK_SIZE } from "teleportal/merkle-tree";
import { AckMessage, RpcMessage, type Message } from "teleportal/protocol";
import { getFileClientHandlers } from "./transfer";
import { onFileTransferProgress, type FileTransferProgress } from "./progress";

async function tick(times = 10) {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

function setupHandler(uploadResponse?: (payload: any) => any) {
  const handler = getFileClientHandlers().fileUpload as any;
  const sentMessages: RpcMessage<any>[] = [];
  handler.setRpcClient(
    {
      sendRequest: async (_doc: string, _method: string, payload: any) => {
        return uploadResponse
          ? uploadResponse(payload)
          : { fileId: payload.fileId, allowed: true, chunkSize: CHUNK_SIZE };
      },
      sendStream: async (msg: RpcMessage<any>) => {
        sentMessages.push(msg);
      },
    },
    async (msg: Message<any>) => {
      sentMessages.push(msg as RpcMessage<any>);
    },
  );
  return { handler, sentMessages };
}

describe("file transfer progress events", () => {
  it("emits active progress per acked chunk and a final complete event", async () => {
    const { handler, sentMessages } = setupHandler();
    const events: FileTransferProgress[] = [];
    const unsubscribe = onFileTransferProgress((p) => events.push(p));

    try {
      const file = new File([new Uint8Array(3 * CHUNK_SIZE)], "big.bin", {
        type: "application/octet-stream",
      });
      const uploadPromise = handler.uploadFile(file, "doc-1");
      await tick();

      const chunkMessages = sentMessages.filter((m) => m.requestType === "stream");
      expect(chunkMessages.length).toBe(3);

      for (const msg of chunkMessages) {
        handler.handleAck(new AckMessage({ type: "ack", messageId: msg.id }));
      }
      const fileId = await uploadPromise;

      expect(events.length).toBeGreaterThanOrEqual(3);
      const last = events.at(-1)!;
      expect(last).toMatchObject({
        fileId,
        document: "doc-1",
        direction: "upload",
        chunksTransferred: 3,
        totalChunks: 3,
        status: "complete",
      });
      expect(last.bytesTransferred).toBe(file.size);

      // Progress is monotonic and payloads carry no chunk data.
      let prev = -1;
      for (const event of events) {
        expect(event.chunksTransferred).toBeGreaterThanOrEqual(prev);
        prev = event.chunksTransferred;
        expect("chunkData" in event).toBe(false);
      }
    } finally {
      unsubscribe();
    }
  });

  it("emits an error event when the upload request is rejected", async () => {
    const { handler } = setupHandler(() => ({
      allowed: false,
      reason: "Upload permission denied",
      statusCode: 403,
    }));
    const events: FileTransferProgress[] = [];
    const unsubscribe = onFileTransferProgress((p) => events.push(p));

    try {
      const file = new File([new Uint8Array(10)], "a.bin");
      const uploadPromise = handler.uploadFile(file, "doc-1");

      await expect(uploadPromise).rejects.toThrow("Upload permission denied");
      const last = events.at(-1)!;
      expect(last.status).toBe("error");
      expect(last.error).toBe("Upload permission denied");
    } finally {
      unsubscribe();
    }
  });
});
