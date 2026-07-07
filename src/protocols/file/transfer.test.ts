import { describe, expect, it } from "bun:test";
import { CHUNK_SIZE } from "teleportal/merkle-tree";
import { AckMessage, RpcMessage, type Message } from "teleportal/protocol";
import { getFileClientHandlers } from "./transfer";

/** Advance the microtask/macrotask queue a few times (0ms — project convention). */
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

describe("upload memory: prepared-chunk release", () => {
  it("releases the prepared-chunks map once every chunk has been streamed", async () => {
    const { handler, sentMessages } = setupHandler();
    const file = new File([new Uint8Array(3 * CHUNK_SIZE)], "big.bin", {
      type: "application/octet-stream",
    });

    const uploadPromise = handler.uploadFile(file, "doc-1");
    await tick();

    const chunkMessages = sentMessages.filter((m) => m.requestType === "stream");
    expect(chunkMessages.length).toBe(3);

    // After streaming (but before ACKs) the whole-file `preparedChunks` copy is
    // released; the chunk data now lives only in `unackedChunks`.
    const state = handler.activeUploads.get(handler.activeUploads.keys().next().value)!;
    expect(state.preparedChunks.size).toBe(0);
    expect(state.unackedChunks.size).toBe(3);

    // ACKing frees chunks incrementally from unackedChunks…
    handler.handleAck(new AckMessage({ type: "ack", messageId: chunkMessages[0].id }));
    expect(state.unackedChunks.size).toBe(2);

    // …and the upload still completes normally after the release.
    for (const msg of chunkMessages.slice(1)) {
      handler.handleAck(new AckMessage({ type: "ack", messageId: msg.id }));
    }
    await expect(uploadPromise).resolves.toBe(state.fileId);
  });

  it("retransmits from unackedChunks after the prepared-chunks map is released", async () => {
    const { handler, sentMessages } = setupHandler();
    const file = new File([new Uint8Array(2 * CHUNK_SIZE)], "retx.bin", {
      type: "application/octet-stream",
    });

    const uploadPromise = handler.uploadFile(file, "doc-1");
    await tick();

    const firstRound = sentMessages.filter((m) => m.requestType === "stream");
    expect(firstRound.length).toBe(2);

    const uploadId = handler.activeUploads.keys().next().value as string;
    const state = handler.activeUploads.get(uploadId)!;
    expect(state.preparedChunks.size).toBe(0); // released

    // NACK the first chunk (retryAfter set) → kicks off the retransmit loop,
    // which must re-send from unackedChunks even though preparedChunks is empty.
    handler.handleAck(new AckMessage({ type: "ack", messageId: firstRound[0].id, retryAfter: 1 }));
    // ACK the second so only one chunk needs retransmission.
    handler.handleAck(new AckMessage({ type: "ack", messageId: firstRound[1].id }));

    // Wait for the retransmit loop to resend the unacked chunk.
    let retransmitted: RpcMessage<any> | undefined;
    for (let i = 0; i < 200 && !retransmitted; i++) {
      await new Promise((r) => setTimeout(r, 1));
      retransmitted = sentMessages
        .filter((m) => m.requestType === "stream")
        .find((m) => !firstRound.includes(m));
    }
    expect(retransmitted).toBeDefined();
    // The retransmitted chunk carries real chunk data (sourced from unackedChunks).
    expect((retransmitted!.payload as any).payload.chunkData.length).toBeGreaterThan(0);

    // ACK the retransmission → upload resolves.
    handler.handleAck(new AckMessage({ type: "ack", messageId: retransmitted!.id }));
    await expect(uploadPromise).resolves.toBe(state.fileId);
  });
});
