import { useState, useEffect, useCallback, useRef } from "react";
import { teleportalEventClient } from "teleportal/providers";
import type {
  DevtoolsMessage,
  DocumentState,
  ConnectionStateInfo,
  Statistics,
} from "../types";
import { DocumentTracker } from "../utils/document-tracker";
import { useDevtoolsSettings } from "./useDevtoolsSettings";
import { Message, RawReceivedMessage } from "teleportal";

export function useTeleportalEvents() {
  const { settings } = useDevtoolsSettings();
  const [messages, setMessages] = useState<DevtoolsMessage[]>([]);
  const [connectionState, setConnectionState] =
    useState<ConnectionStateInfo | null>(null);
  const [documents, setDocuments] = useState<DocumentState[]>([]);
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
  const lastUpdateRef = useRef(Date.now());
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
      connectionState,
      documentCount: allDocs.length,
      messageRate: rate,
    });

    setDocuments(allDocs);
  }, [messages, connectionState]);

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

        // Handle ACK messages separately - don't add to list, but track them
        if (message.type === "ack" && message.payload?.type === "ack") {
          const ackedMessageId = message.payload.messageId;
          if (ackedMessageId) {
            const ackMessageId = `${Date.now()}-${Math.random()}`;

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

      // Handle ACK messages separately - don't add to list, but track them
      if (message.type === "ack" && message.payload?.type === "ack") {
        const ackedMessageId = message.payload.messageId;
        if (ackedMessageId) {
          const ackMessageId = `${Date.now()}-${Math.random()}`;

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
    const unsubConnected = teleportalEventClient.on("connected", () => {
      setConnectionState({
        type: "connected",
        transport: "websocket", // Could be determined from connection if available
        timestamp: Date.now(),
      });
    });
    unsubscribers.push(unsubConnected);

    const unsubDisconnected = teleportalEventClient.on("disconnected", () => {
      setConnectionState({
        type: "disconnected",
        transport: null,
        timestamp: Date.now(),
      });
    });
    unsubscribers.push(unsubDisconnected);

    const unsubUpdate = teleportalEventClient.on("update", (event) => {
      const { state } = event.payload;
      setConnectionState({
        type: state.type,
        transport:
          state.type === "connected"
            ? "websocket"
            : state.type === "connecting"
              ? null
              : null,
        error:
          state.type === "errored"
            ? state.error?.message || String(state.error)
            : undefined,
        timestamp: Date.now(),
      });
    });
    unsubscribers.push(unsubUpdate);

    return () => {
      unsubscribers.forEach((unsub) => unsub());
    };
  }, [settings.messageLimit]);

  const clearMessages = useCallback(() => {
    setMessages([]);
    messageRateRef.current = [];
  }, []);

  return {
    messages,
    connectionState,
    documents,
    statistics,
    clearMessages,
  };
}
