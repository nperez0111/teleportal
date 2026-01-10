import { Counter, Gauge, Histogram, Registry } from "./metrics";

export class MetricsCollector {
  public readonly clientsActive: Gauge;
  public readonly sessionsActive: Gauge;
  public readonly documentsOpenedTotal: Counter;
  public readonly messagesTotal: Counter;
  public readonly totalMessagesProcessed: Counter;
  public readonly messageDuration: Histogram;
  public readonly storageOperationsTotal: Counter;
  public readonly storageOperationDuration: Histogram;
  public readonly errorsTotal: Counter;

  constructor(registry: Registry) {
    // Custom metrics
    this.clientsActive = new Gauge(
      "teleportal_clients_active",
      "Number of currently active client connections",
    );

    this.sessionsActive = new Gauge(
      "teleportal_sessions_active",
      "Number of currently active document sessions",
    );

    this.documentsOpenedTotal = new Counter(
      "teleportal_documents_opened_total",
      "Total number of documents opened",
    );

    this.messagesTotal = new Counter(
      "teleportal_messages_total",
      "Total number of messages processed",
      ["type"],
    );

    this.totalMessagesProcessed = new Counter(
      "teleportal_messages_total_all",
      "Total number of messages processed (all types)",
    );

    this.messageDuration = new Histogram(
      "teleportal_message_duration_seconds",
      "Duration of message processing",
      [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2.5, 5],
      ["type"],
    );

    this.storageOperationsTotal = new Counter(
      "teleportal_storage_operations_total",
      "Total number of storage operations",
      ["operation", "result"],
    );

    this.storageOperationDuration = new Histogram(
      "teleportal_storage_operation_duration_seconds",
      "Duration of storage operations",
      [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2.5, 5],
      ["operation"],
    );

    this.errorsTotal = new Counter(
      "teleportal_errors_total",
      "Total number of errors",
      ["type"],
    );

    // Register all metrics
    registry.register(this.clientsActive);
    registry.register(this.sessionsActive);
    registry.register(this.documentsOpenedTotal);
    registry.register(this.messagesTotal);
    registry.register(this.totalMessagesProcessed);
    registry.register(this.messageDuration);
    registry.register(this.storageOperationsTotal);
    registry.register(this.storageOperationDuration);
    registry.register(this.errorsTotal);
  }

  /**
   * Increment message count for a specific type
   */
  incrementMessage(type: string): void {
    this.messagesTotal.inc({ type });
    this.totalMessagesProcessed.inc();
  }

  /**
   * Get message counts by type
   */
  getMessageCountsByType(): Record<string, number> {
    const result: Record<string, number> = {};
    // Since Counter now stores per-label values, we need to aggregate
    // But for messages_total, we want the count per type
    // The counter format is: messagesTotal.inc({ type: "doc" })
    // So we need to get the value for each {type: "..."} label
    for (const [key, value] of (this.messagesTotal as any).values) {
      if (key) {
        const labels = JSON.parse(key);
        if (labels.type) {
          result[labels.type] = value;
        }
      }
    }
    return result;
  }
}
