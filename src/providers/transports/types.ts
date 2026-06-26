import type { Message, RawReceivedMessage } from "teleportal";
import type { Timer } from "../utils";

export interface ConnectionTransport {
  readonly name: string;

  connect(ctx: TransportConnectContext): Promise<void>;

  send(message: Message): Promise<void>;

  close(): Promise<void>;

  sendHeartbeat?(): void;

  timeout?: number;

  probe?(ctx: { url?: string; token?: string; timer: Timer }): Promise<boolean>;
}

export interface TransportConnectContext {
  url?: string;
  token?: string;
  onMessage(message: RawReceivedMessage): void;
  onClose(error?: Error): void;
  onPing(): void;
  timer: Timer;
}

export interface TokenOptions {
  token: string;
  onTokenExpired?: (currentToken: string) => Promise<string>;
  refreshBeforeExpiryMs?: number;
}
