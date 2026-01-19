import type { RpcMessage } from "teleportal/protocol";
import type { ClientContext, Message } from "teleportal";
import type { Provider } from "./provider";

/**
 * Context for client RPC handlers.
 */
export interface ClientRpcContext extends ClientContext, Record<string, unknown> {
  documentId: string;
}

/**
 * A client-side RPC handler for a specific RPC method.
 * Handles both outgoing requests and incoming responses/streams.
 */
export interface ClientRpcHandler<Context extends ClientRpcContext = ClientRpcContext> {
  /**
   * Send an outgoing RPC request.
   * @param payload - The request payload
   * @param context - The RPC context
   * @returns The request ID for tracking responses
   */
  request?(
    payload: Record<string, unknown>,
    context: Context,
  ): Promise<string> | string;

  /**
   * Handle an incoming RPC response message.
   * @param message - The RPC response message
   * @returns true if the message was handled, false otherwise
   */
  handleResponse?(message: RpcMessage<Context>): Promise<boolean> | boolean;

  /**
   * Handle an incoming RPC stream message.
   * @param message - The RPC stream message
   * @returns true if the message was handled, false otherwise
   */
  handleStream?(message: RpcMessage<Context>): Promise<boolean> | boolean;

  /**
   * Handle an incoming ACK message.
   * @param message - The ACK message
   * @returns true if the message was handled, false otherwise
   */
  handleAck?(message: Message<Context>): Promise<boolean> | boolean;

  /**
   * Initialize the handler with the provider instance.
   * Called when the provider is created.
   * @param provider - The provider instance
   * @returns Optional cleanup function called when provider is destroyed
   */
  init?(provider: Provider<any>): (() => void) | void;
}

/**
 * Registry of client RPC handlers, keyed by method name.
 */
export type ClientRpcHandlerRegistry = {
  [method: string]: ClientRpcHandler<any>;
};
