import type { RpcSuccess, RpcError } from "teleportal/protocol";
import { RpcMessage } from "teleportal/protocol";
import type { Connection } from "./connection";

export class RpcClient {
  #connection: Connection<any>;
  #pendingRequests: Map<
    string,
    {
      resolve: (value: RpcSuccess) => void;
      reject: (error: Error) => void;
      onStream?: (payload: unknown) => void;
      timeoutId: ReturnType<typeof setTimeout>;
    }
  > = new Map();
  #messageHandler: (() => void) | null = null;
  #timeout: number = 30000;

  constructor(connection: Connection<any>) {
    this.#connection = connection;
    this.#setupMessageListener();
  }

  #setupMessageListener() {
    this.#messageHandler = this.#connection.on(
      "received-message",
      (message) => {
        if (message.type !== "rpc") return;
        if (
          message.requestType !== "response" &&
          message.requestType !== "stream"
        )
          return;

        const originalRequestId = message.originalRequestId;
        if (!originalRequestId) return;

        const pending = this.#pendingRequests.get(originalRequestId);
        if (!pending) return;

        if (message.requestType === "stream") {
          if (message.payload.type === "success" && pending.onStream) {
            pending.onStream(message.payload.payload);
          }
          return;
        }

        const response = message.payload as RpcSuccess | RpcError;
        if (response.type === "error") {
          pending.reject(
            new RpcOperationError(
              response.statusCode,
              response.details,
              response.payload,
            ),
          );
        } else {
          pending.resolve(response);
        }
      },
    );
  }

  /**
   * Register an external handler for RPC messages.
   * Returns a function to unregister the handler.
   */
  onMessage(
    handler: (message: RpcMessage<any>) => void | Promise<void>,
  ): () => void {
    const messageHandler = this.#connection.on(
      "received-message",
      async (message) => {
        if (message.type === "rpc") {
          await handler(message);
        }
      },
    );

    return () => {
      messageHandler();
    };
  }

  async sendRequest<TResponse>(
    document: string,
    method: string,
    payload: Record<string, unknown>,
    options?: {
      onStream?: (payload: unknown) => void;
      timeout?: number;
      encrypted?: boolean;
      context?: Record<string, unknown>;
    },
  ): Promise<TResponse> {
    await this.#connection.connected;

    const requestPayload: Record<string, unknown> = { method };
    if (payload && typeof payload === "object") {
      for (const [key, value] of Object.entries(payload)) {
        requestPayload[key] = value;
      }
    }
    const request = new RpcMessage(
      document,
      { type: "success", payload: requestPayload },
      method,
      "request",
      undefined,
      options?.context ?? {},
      options?.encrypted ?? false,
    );

    const requestId = request.id;

    return new Promise((resolve, reject) => {
      const timeoutMs = options?.timeout ?? this.#timeout;
      const timeoutId = setTimeout(() => {
        this.#pendingRequests.delete(requestId);
        reject(new Error(`RPC request timeout: ${method}`));
      }, timeoutMs);

      this.#pendingRequests.set(requestId, {
        resolve: (response: RpcSuccess) => {
          clearTimeout(timeoutId);
          this.#pendingRequests.delete(requestId);
          resolve(response.payload as TResponse);
        },
        reject: (error: Error) => {
          clearTimeout(timeoutId);
          this.#pendingRequests.delete(requestId);
          reject(error);
        },
        onStream: options?.onStream,
        timeoutId,
      });

      this.#connection.send(request).catch((error) => {
        clearTimeout(timeoutId);
        this.#pendingRequests.delete(requestId);
        reject(error);
      });
    });
  }

  /**
   * Send an RPC stream message (for file chunks, etc.).
   * @param message - The RPC stream message to send
   */
  async sendStream(message: RpcMessage<any>): Promise<void> {
    await this.#connection.connected;
    await this.#connection.send(message);
  }

  destroy() {
    if (this.#messageHandler) {
      this.#messageHandler();
      this.#messageHandler = null;
    }
    this.#pendingRequests.forEach((pending) => {
      clearTimeout(pending.timeoutId);
    });
    this.#pendingRequests.clear();
  }
}

export class RpcOperationError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly details: string,
    public readonly payload?: unknown,
  ) {
    super(`RPC error (${statusCode}): ${details}`);
    this.name = "RpcOperationError";
  }
}
