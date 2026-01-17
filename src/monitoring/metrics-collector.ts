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
  public readonly documentSizeBytes: Gauge;
  public readonly documentSizeWarningTotal: Counter;
  public readonly documentSizeLimitExceededTotal: Counter;
  public readonly milestonesTotal: Gauge;
  public readonly milestonesCreatedTotal: Counter;
  public readonly milestonesSoftDeletedTotal: Counter;
  public readonly milestonesRestoredTotal: Counter;
  public readonly rateLimitExceededTotal: Counter;
  public readonly rateLimitStateOperationsTotal: Counter;
  public readonly rateLimitStateSize: Gauge;

  private rateLimitRecentEvents: Array<{
    timestamp: string;
    userId: string;
    documentId: string;
    trackBy: string;
  }> = [];

  private readonly MAX_RECENT_EVENTS = 100;

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

    this.documentSizeBytes = new Gauge(
      "teleportal_document_size_bytes",
      "Current size of document in bytes",
      ["documentId", "encrypted"],
    );

    this.documentSizeWarningTotal = new Counter(
      "teleportal_document_size_warning_total",
      "Total number of document size warnings",
      ["documentId"],
    );

    this.documentSizeLimitExceededTotal = new Counter(
      "teleportal_document_size_limit_exceeded_total",
      "Total number of document size limit exceeded events",
      ["documentId"],
    );

    this.milestonesTotal = new Gauge(
      "teleportal_milestones_total",
      "Total number of milestones",
      ["documentId", "lifecycleState"],
    );

    this.milestonesCreatedTotal = new Counter(
      "teleportal_milestones_created_total",
      "Total number of milestones created",
      ["documentId", "triggerType"],
    );

    this.milestonesSoftDeletedTotal = new Counter(
      "teleportal_milestones_soft_deleted_total",
      "Total number of milestones soft deleted",
      ["documentId"],
    );

    this.milestonesRestoredTotal = new Counter(
      "teleportal_milestones_restored_total",
      "Total number of milestones restored",
      ["documentId"],
    );

    this.rateLimitExceededTotal = new Counter(
      "teleportal_rate_limit_exceeded_total",
      "Total number of rate limit exceeded events",
      ["userId", "documentId", "trackBy"],
    );

    this.rateLimitStateOperationsTotal = new Counter(
      "teleportal_rate_limit_state_operations_total",
      "Total number of rate limit state storage operations",
      ["operation", "trackBy"],
    );

    this.rateLimitStateSize = new Gauge(
      "teleportal_rate_limit_state_size",
      "Number of active rate limit states",
      ["trackBy"],
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
    registry.register(this.documentSizeBytes);
    registry.register(this.documentSizeWarningTotal);
    registry.register(this.documentSizeLimitExceededTotal);
    registry.register(this.milestonesTotal);
    registry.register(this.milestonesCreatedTotal);
    registry.register(this.milestonesSoftDeletedTotal);
    registry.register(this.milestonesRestoredTotal);
    registry.register(this.rateLimitExceededTotal);
    registry.register(this.rateLimitStateOperationsTotal);
    registry.register(this.rateLimitStateSize);
  }

  /**
   * Record the size of a document
   */
  recordDocumentSize(
    documentId: string,
    sizeBytes: number,
    encrypted: boolean,
  ): void {
    this.documentSizeBytes.set(sizeBytes, {
      documentId,
      encrypted: encrypted.toString(),
    });
  }

  /**
   * Increment size warning counter for a document
   */
  incrementSizeWarning(documentId: string): void {
    this.documentSizeWarningTotal.inc({ documentId });
  }

  /**
   * Increment size limit exceeded counter for a document
   */
  incrementSizeLimitExceeded(documentId: string): void {
    this.documentSizeLimitExceededTotal.inc({ documentId });
  }

  /**
   * Record milestone creation
   */
  recordMilestoneCreated(documentId: string, triggerType: string): void {
    this.milestonesCreatedTotal.inc({ documentId, triggerType });
  }

  /**
   * Record milestone soft deletion
   */
  recordMilestoneSoftDeleted(documentId: string): void {
    this.milestonesSoftDeletedTotal.inc({ documentId });
  }

  /**
   * Record milestone restoration
   */
  recordMilestoneRestored(documentId: string): void {
    this.milestonesRestoredTotal.inc({ documentId });
  }

  /**
   * Record milestone expiration
   */

  /**
   * Record rate limit exceeded event
   */
  recordRateLimitExceeded(
    userId: string,
    documentId: string | undefined,
    trackBy: string,
  ): void {
    this.rateLimitExceededTotal.inc({
      userId,
      documentId: documentId ?? "",
      trackBy,
    });

    this.rateLimitRecentEvents.unshift({
      timestamp: new Date().toISOString(),
      userId,
      documentId: documentId ?? "",
      trackBy,
    });

    if (this.rateLimitRecentEvents.length > this.MAX_RECENT_EVENTS) {
      this.rateLimitRecentEvents.pop();
    }
  }

  /**
   * Record rate limit state storage operation
   */
  recordRateLimitStateOperation(operation: string, trackBy: string): void {
    this.rateLimitStateOperationsTotal.inc({ operation, trackBy });
  }

  /**
   * Update size of rate limit state
   */
  updateRateLimitStateSize(trackBy: string, size: number): void {
    this.rateLimitStateSize.set(size, { trackBy });
  }

  /**
   * Update milestone count for a specific state
   */
  updateMilestoneCount(
    documentId: string,
    lifecycleState: string,
    count: number,
  ): void {
    this.milestonesTotal.set(count, { documentId, lifecycleState });
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

  /**
   * Get top rate limit offenders
   */
  getRateLimitTopOffenders(limit: number = 10): Array<{
    userId: string;
    documentId: string;
    count: number;
    trackBy: string;
  }> {
    const offenders: Array<{
      userId: string;
      documentId: string;
      count: number;
      trackBy: string;
    }> = [];

    for (const [key, value] of (this.rateLimitExceededTotal as any).values) {
      if (key) {
        const labels = JSON.parse(key);
        offenders.push({
          userId: labels.userId,
          documentId: labels.documentId,
          trackBy: labels.trackBy,
          count: value,
        });
      }
    }

    return offenders.sort((a, b) => b.count - a.count).slice(0, limit);
  }

  /**
   * Get recent rate limit events
   */
  getRateLimitRecentEvents(limit: number = 10): Array<{
    timestamp: string;
    userId: string;
    documentId: string;
    trackBy: string;
  }> {
    return this.rateLimitRecentEvents.slice(0, limit);
  }

  /**
   * Get rate limit exceeded counts by trackBy
   */
  getRateLimitCountsByTrackBy(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [key, value] of (this.rateLimitExceededTotal as any).values) {
      if (key) {
        const labels = JSON.parse(key);
        if (labels.trackBy) {
          result[labels.trackBy] = (result[labels.trackBy] || 0) + value;
        }
      }
    }
    return result;
  }
}
