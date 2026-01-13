import { useState, useEffect, useCallback, useRef } from "react";
import { teleportalEventClient } from "teleportal/providers";
import type {
  DevtoolsMessage,
  ConnectionStateInfo,
  Statistics,
} from "../types";
import type { Message, RawReceivedMessage } from "teleportal";
import { DocumentTracker } from "../utils/document-tracker";
import { useDevtoolsSettings } from "./useDevtoolsSettings";

export function useTeleportalEvents() {
  const { settings } = useDevtoolsSettings();
  const [messages, setMessages] = useState<DevtoolsMessage[]>([]);
  const [connectionState, setConnectionState] =
    useState<ConnectionStateInfo | null>({
      type: "disconnected",
      transport: null,
      timestamp: Date.now(),
    });
  const [statistics, setStatistics] = useState<Statistics>({
    totalMessages: 0,
    messagesByType: {},
    sentCount: 0,
    receivedCount: 0,
    connectionState: null,
    documentCount: 0,
    messageRate: 0,
  });

  const trackerRef = useRef(new DocumentTracker());
  const messageRateRef = useRef<number[]>([]);
  const connectionStateRef = useRef<ConnectionStateInfo | null>({
    type: "disconnected",
    transport: null,
    timestamp: Date.now(),
  });
  const ackMessagesRef = useRef<
    Map<
      string,
      {
        ackMessageId: string;
        ackMessage: Message | RawReceivedMessage;
        timestamp: number;
      }
    >
  >(new Map());

  const updateStatistics = useCallback(() => {
    const tracker = trackerRef.current;
    const allDocs = tracker.getAllDocuments();

    const messagesByType: Record<string, number> = {};
    let sentCount = 0;
    let receivedCount = 0;

    messages.forEach((msg) => {
      const type =
        msg.message.type === "doc"
          ? msg.message.payload.type
          : msg.message.type;
      messagesByType[type] = (messagesByType[type] || 0) + 1;

      if (msg.direction === "sent") sentCount++;
      else receivedCount++;
    });

    // Calculate message rate (messages per second over last 10 seconds)
    const now = Date.now();
    messageRateRef.current = messageRateRef.current.filter(
      (ts) => now - ts < 10000,
    );
    const rate = messageRateRef.current.length / 10;

    setStatistics({
      totalMessages: messages.length,
      messagesByType,
      sentCount,
      receivedCount,
      connectionState: connectionStateRef.current,
      documentCount: allDocs.length,
      messageRate: rate,
    });
  }, [messages]);

  useEffect(() => {
    updateStatistics();
  }, [updateStatistics]);

  useEffect(() => {
    const tracker = trackerRef.current;

    // Set up individual event listeners
    const unsubscribers: Array<() => void> = [];

    // Listen to received messages
    const unsubReceived = teleportalEventClient.on(
      "received-message",
      (event) => {
        const { message, provider, connection } = event.payload;

        // Check connection state from the connection object if available
        // This is a fallback in case connection events don't fire or fire before listeners are set up
        if (
          connection &&
          typeof connection.state === "object" &&
          connection.state
        ) {
          const connState = connection.state;
          if (
            connState.type &&
            connState.type !== connectionStateRef.current?.type
          ) {
            const newState: ConnectionStateInfo = {
              type: connState.type,
              transport: connState.type === "connected" ? "websocket" : null,
              error:
                connState.type === "errored"
                  ? connState.error?.message || String(connState.error)
                  : undefined,
              timestamp: Date.now(),
            };
            connectionStateRef.current = newState;
            setConnectionState(newState);
          }
        }

        // Handle ACK messages separately - don't add to list, but track them
        if (message.type === "ack" && message.payload?.type === "ack") {
          const ackedMessageId = message.payload.messageId;
          if (ackedMessageId) {
            // Use the ACK message's actual ID (deterministic getter)
            const ackMessageId = message.id;

            // Store ACK info
            ackMessagesRef.current.set(ackedMessageId, {
              ackMessageId,
              ackMessage: message,
              timestamp: Date.now(),
            });

            // Update the corresponding message to mark it as ACKed
            setMessages((prev) =>
              prev.map((msg) => {
                const msgId = msg.message.id || msg.id;
                if (msgId === ackedMessageId) {
                  return {
                    ...msg,
                    ackedBy: {
                      ackMessageId,
                      ackMessage: message,
                      timestamp: Date.now(),
                    },
                  };
                }
                return msg;
              }),
            );
          }

          messageRateRef.current.push(Date.now());
          return;
        }

        const docId = message.document || "unknown";
        tracker.addDocument(docId, provider, docId);
        tracker.updateDocumentActivity(docId);

        // Always use message.id - it's a getter that computes the ID deterministically
        const messageId = message.id;

        setMessages((prev) => {
          // Check for duplicates by message ID before adding
          const existing = prev.find((msg) => {
            const msgId = msg.message.id || msg.id;
            return msgId === messageId;
          });
          if (existing) {
            return prev;
          }

          const devtoolsMessage: DevtoolsMessage = {
            id: messageId,
            message,
            direction: "received",
            timestamp: Date.now(),
            document: docId,
            provider,
            connection,
          };

          const updated = [...prev, devtoolsMessage];
          // Enforce message limit
          if (updated.length > settings.messageLimit) {
            return updated.slice(-settings.messageLimit);
          }
          return updated;
        });

        messageRateRef.current.push(Date.now());
      },
    );
    unsubscribers.push(unsubReceived);

    // Listen to sent messages
    const unsubSent = teleportalEventClient.on("sent-message", (event) => {
      const { message, provider, connection } = event.payload;

      // Check connection state from the connection object if available
      // This is a fallback in case connection events don't fire or fire before listeners are set up
      if (
        connection &&
        typeof connection.state === "object" &&
        connection.state
      ) {
        const connState = connection.state;
        if (
          connState.type &&
          connState.type !== connectionStateRef.current?.type
        ) {
          const newState: ConnectionStateInfo = {
            type: connState.type,
            transport: connState.type === "connected" ? "websocket" : null,
            error:
              connState.type === "errored"
                ? connState.error?.message || String(connState.error)
                : undefined,
            timestamp: Date.now(),
          };
          connectionStateRef.current = newState;
          setConnectionState(newState);
        }
      }

      // Handle ACK messages separately - don't add to list, but track them
      if (message.type === "ack" && message.payload?.type === "ack") {
        const ackedMessageId = message.payload.messageId;
        if (ackedMessageId) {
          // Use the ACK message's actual ID (deterministic getter)
          const ackMessageId = message.id;

          // Store ACK info
          ackMessagesRef.current.set(ackedMessageId, {
            ackMessageId,
            ackMessage: message,
            timestamp: Date.now(),
          });

          // Update the corresponding message to mark it as ACKed
          setMessages((prev) =>
            prev.map((msg) => {
              const msgId = msg.message.id || msg.id;
              if (msgId === ackedMessageId) {
                return {
                  ...msg,
                  ackedBy: {
                    ackMessageId,
                    ackMessage: message,
                    timestamp: Date.now(),
                  },
                };
              }
              return msg;
            }),
          );
        }

        messageRateRef.current.push(Date.now());
        return;
      }

      const docId = message.document || "unknown";
      tracker.addDocument(docId, provider, docId);
      tracker.updateDocumentActivity(docId);

      // Always use message.id - it's a getter that computes the ID deterministically
      const messageId = message.id;

      setMessages((prev) => {
        // Check for duplicates by message ID before adding
        const existing = prev.find((msg) => {
          const msgId = msg.message.id || msg.id;
          return msgId === messageId;
        });
        if (existing) {
          return prev;
        }

        const devtoolsMessage: DevtoolsMessage = {
          id: messageId,
          message,
          direction: "sent",
          timestamp: Date.now(),
          document: docId,
          provider,
          connection,
        };

        const updated = [...prev, devtoolsMessage];
        if (updated.length > settings.messageLimit) {
          return updated.slice(-settings.messageLimit);
        }
        return updated;
      });

      messageRateRef.current.push(Date.now());
    });
    unsubscribers.push(unsubSent);

    // Listen to subdoc load
    const unsubLoadSubdoc = teleportalEventClient.on("load-subdoc", (event) => {
      const { document, provider } = event.payload;
      tracker.addDocument(document, provider, document);
    });
    unsubscribers.push(unsubLoadSubdoc);

    // Listen to subdoc unload
    const unsubUnloadSubdoc = teleportalEventClient.on(
      "unload-subdoc",
      (event) => {
        const { document } = event.payload;
        tracker.removeDocument(document);
      },
    );
    unsubscribers.push(unsubUnloadSubdoc);

    // Listen to connection events
    const unsubConnected = teleportalEventClient.on("connected", (event) => {
      const newState = {
        type: "connected" as const,
        transport: "websocket" as const,
        timestamp: Date.now(),
      };
      connectionStateRef.current = newState;
      setConnectionState(newState);
    });
    unsubscribers.push(unsubConnected);

    const unsubDisconnected = teleportalEventClient.on(
      "disconnected",
      (event) => {
        const newState = {
          type: "disconnected" as const,
          transport: null,
          timestamp: Date.now(),
        };
        connectionStateRef.current = newState;
        setConnectionState(newState);
      },
    );
    unsubscribers.push(unsubDisconnected);

    const unsubUpdate = teleportalEventClient.on("update", (event) => {
      const { state } = event.payload;
      const newState: ConnectionStateInfo = {
        type: state.type,
        transport: state.type === "connected" ? "websocket" : null,
        error:
          state.type === "errored"
            ? state.error?.message || String(state.error)
            : undefined,
        timestamp: Date.now(),
      };
      connectionStateRef.current = newState;
      setConnectionState(newState);
    });
    unsubscribers.push(unsubUpdate);

    return () => {
      unsubscribers.forEach((unsub) => unsub());
    };
  }, [settings.messageLimit]);

  return {
    messages,
    connectionState,
    statistics,
  };
}
