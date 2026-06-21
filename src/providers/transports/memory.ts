import type { Message, RawReceivedMessage } from "teleportal";
import type { ConnectionTransport, TransportConnectContext } from "./types";

export interface MemoryTransportOptions {
  latency?: number;
}

export interface MemoryTransportHandle extends ConnectionTransport {
  readonly sentMessages: Message[];
  readonly receivedMessages: RawReceivedMessage[];
  simulateDisconnect(): void;
  simulateError(error: Error): void;
  clearHistory(): void;
}

export function createMemoryTransportPair(
  options?: MemoryTransportOptions,
): [client: MemoryTransportHandle, server: MemoryTransportHandle] {
  const latency = options?.latency ?? 0;

  const a = createMemoryTransport(latency);
  const b = createMemoryTransport(latency);
  a._setPeer(b);
  b._setPeer(a);

  return [a, b];
}

function createMemoryTransport(latency: number): MemoryTransportHandle & {
  _setPeer(
    peer: MemoryTransportHandle & {
      _deliver(message: RawReceivedMessage): void;
      _ctx: TransportConnectContext | null;
    },
  ): void;
  _deliver(message: RawReceivedMessage): void;
  _ctx: TransportConnectContext | null;
} {
  let ctx: TransportConnectContext | null = null;
  let peer: ReturnType<typeof createMemoryTransport> | null = null;
  let connected = false;

  const sentMessages: Message[] = [];
  const receivedMessages: RawReceivedMessage[] = [];

  const transport: MemoryTransportHandle & {
    _setPeer(p: ReturnType<typeof createMemoryTransport>): void;
    _deliver(message: RawReceivedMessage): void;
    _ctx: TransportConnectContext | null;
  } = {
    name: "memory",
    timeout: 1000,

    get _ctx() {
      return ctx;
    },

    _setPeer(p) {
      peer = p;
    },

    _deliver(message: RawReceivedMessage) {
      if (!connected || !ctx) return;
      receivedMessages.push(message);
      ctx.onMessage(message);
    },

    async connect(connectCtx: TransportConnectContext) {
      ctx = connectCtx;
      connected = true;
    },

    async send(message: Message) {
      if (!connected || !peer) {
        throw new Error("Memory transport not connected");
      }

      sentMessages.push(message);

      if (!peer._ctx) return;

      if (latency > 0) {
        const timer = ctx?.timer;
        if (timer) {
          timer.setTimeout(() => {
            peer!._deliver(message as unknown as RawReceivedMessage);
          }, latency);
        } else {
          setTimeout(() => {
            peer!._deliver(message as unknown as RawReceivedMessage);
          }, latency);
        }
      } else {
        queueMicrotask(() => {
          peer!._deliver(message as unknown as RawReceivedMessage);
        });
      }
    },

    async close() {
      connected = false;
      if (peer?._ctx) {
        peer._ctx.onClose();
      }
    },

    get sentMessages() {
      return sentMessages;
    },

    get receivedMessages() {
      return receivedMessages;
    },

    simulateDisconnect() {
      connected = false;
      ctx?.onClose();
    },

    simulateError(error: Error) {
      connected = false;
      ctx?.onClose(error);
    },

    clearHistory() {
      sentMessages.length = 0;
      receivedMessages.length = 0;
    },
  };

  return transport;
}
