/**
 * Lightweight file-transfer progress reporting.
 *
 * Chunk payloads deliberately stay off the message-event pipeline (see
 * `Connection.sendStream`) — routing 64KB buffers through per-message events
 * measurably slows uploads. Instead the file client handler emits these tiny,
 * numbers-only snapshots, which tooling (e.g. the devtools) can subscribe to.
 */
export type FileTransferProgress = {
  /**
   * The transfer id used on the wire: the request payload's fileId
   * (client-generated uploadId for uploads, requested fileId for downloads).
   */
  fileId: string;
  document: string;
  direction: "upload" | "download";
  /** Chunks durably transferred: acknowledged (upload) or received (download). */
  chunksTransferred: number;
  totalChunks?: number;
  /** Approximate plaintext bytes transferred. */
  bytesTransferred: number;
  status: "active" | "complete" | "error";
  error?: string;
};

type ProgressListener = (progress: FileTransferProgress) => void;

const listeners = new Set<ProgressListener>();

/**
 * Subscribe to file-transfer progress from all file client handlers in this
 * JS context. Returns an unsubscribe function.
 */
export function onFileTransferProgress(listener: ProgressListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** @internal Emitted by the file client handler. */
export function emitFileTransferProgress(progress: FileTransferProgress): void {
  for (const listener of listeners) {
    try {
      listener(progress);
    } catch {
      // Listeners must never break a transfer.
    }
  }
}
