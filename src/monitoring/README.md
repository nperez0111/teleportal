# `teleportal/monitoring`

Metric primitives and a `MetricsCollector` that together produce the Prometheus
data the server exposes at `/metrics` and the aggregates it exposes at
`/status`.

## Why it exists

Teleportal is runtime-agnostic and keeps its dependency count minimal, so it
ships its own tiny Prometheus implementation (`metrics.ts`) instead of pulling
in `prom-client`. The `MetricsCollector` (`metrics-collector.ts`) is the single
place that declares every metric the server records, wires them into a
`Registry`, and offers typed helpers plus a few in-memory aggregates (rate-limit
top-offenders / recent-events ring buffer) that back the `/status` endpoint.

This module only **defines** metrics and the `HealthStatus` / `StatusData`
**types**. It does **not** implement health checks, uptime, or the HTTP
endpoints — the server (`src/server`) records into the collector and the HTTP
handlers (`src/http`) serialize `register.format()` and build `StatusData`.

## What it contains

| File                   | Responsibility                                                              |
| ---------------------- | --------------------------------------------------------------------------- |
| `metrics.ts`           | `Counter`, `Gauge`, `Histogram`, `Registry`, and the global `register`.     |
| `metrics-collector.ts` | `MetricsCollector`: declares/registers every metric + typed record helpers. |
| `types.ts`             | `HealthStatus`, `StatusData`, `MetricsData` shapes (consumed by http).      |
| `index.ts`             | Public surface: re-exports `types` and `metrics-collector`.                 |

### Public exports

`teleportal/monitoring` (via `index.ts`) exports **only**:

- `MetricsCollector`
- `HealthStatus`, `StatusData`, `MetricsData` (types)

The metric primitives (`Counter`, `Gauge`, `Histogram`, `Registry`, `register`)
are **not** re-exported from the package entry point — there is no
`teleportal/monitoring/metrics` subpath in `package.json`. Internal code imports
them by relative path (`../monitoring/metrics`), e.g. the server owns the global
`register` and hands it to the collector.

## Metric primitives (`metrics.ts`)

A minimal, allocation-light Prometheus text encoder. Each metric stores a
`Map<serializedLabels, value>`, where the key is `JSON.stringify(labels)`
(`""` for the no-label series).

- **`Counter`** — monotonic. `inc(labels?, amount = 1)`; `getValue(labels?)`
  returns the per-label value, or the sum across all label sets when called
  without labels; `getTotalValue()` sums every series.
- **`Gauge`** — `inc` / `dec` (by 1), `set(value, labels?)`, `getValue`,
  `getValues()` (all label/value pairs). **Gauges are signed**: `dec()` below
  zero is allowed on purpose. A negative gauge is a real diagnostic signal of an
  upstream inc/dec imbalance, so this layer must not clamp it. (Balancing the
  inc/dec pairs is the caller's job — e.g. `clients_active` in `src/server`.)
- **`Histogram`** — `observe(value)` or `observe(labels, value)`. Buckets are
  **cumulative** (an observation lands in every bucket whose `le` it satisfies,
  plus `+Inf`), matching Prometheus semantics; emits `_bucket`, `_count`,
  `_sum`. Label values and `le` are merged into one label set (valid exposition
  format).
- **`Registry`** — `register(metric)` / `format()` (concatenated exposition
  text). `register` is the process-global instance.

Label values are escaped (`\`, `"`, newline). Label **names** passed to the
constructors are currently descriptive only — they are not validated against the
labels supplied at record time.

## Metrics catalog

All metrics are prefixed `teleportal_`.

### Counters

| Metric                                     | Labels                            | Meaning                                        |
| ------------------------------------------ | --------------------------------- | ---------------------------------------------- |
| `documents_opened_total`                   | —                                 | Documents opened.                              |
| `messages_total`                           | `type`                            | Messages processed, per message type.          |
| `messages_total_all`                       | —                                 | Messages processed (all types, single series). |
| `storage_operations_total`                 | `operation`, `result`             | Storage operations.                            |
| `storage_operation_duration_seconds` _(H)_ | `operation`                       | Storage op latency (histogram).                |
| `errors_total`                             | `type`                            | Errors.                                        |
| `document_size_warning_total`              | `documentId`                      | Size-warning events.                           |
| `document_size_limit_exceeded_total`       | `documentId`                      | Size-limit-exceeded events.                    |
| `milestones_created_total`                 | `documentId`, `triggerType`       | Milestones created.                            |
| `milestones_soft_deleted_total`            | `documentId`                      | Milestones soft-deleted.                       |
| `milestones_restored_total`                | `documentId`                      | Milestones restored.                           |
| `rate_limit_exceeded_total`                | `userId`, `documentId`, `trackBy` | Rate-limit **exceeded** (dropped) events.      |
| `rate_limit_delayed_total`                 | `userId`, `documentId`, `trackBy` | Inbound messages **held** by flow control.     |
| `rate_limit_delay_ms_total`                | `userId`, `documentId`, `trackBy` | Cumulative ms messages spent held.             |
| `rate_limit_state_operations_total`        | `operation`, `trackBy`            | Rate-limit state storage operations.           |

`rate_limit_delayed_total` (healthy: limiting engaged without data loss) is
tracked separately from `rate_limit_exceeded_total` (a drop). `delay_ms_total`
divided by `delayed_total` gives mean hold time.

### Gauges

| Metric                  | Labels                         | Meaning                              |
| ----------------------- | ------------------------------ | ------------------------------------ |
| `clients_active`        | —                              | Active client connections.           |
| `sessions_active`       | —                              | Active document sessions.            |
| `document_size_bytes`   | `documentId`, `encrypted`      | Current document size.               |
| `milestones_total`      | `documentId`, `lifecycleState` | Milestone count per lifecycle state. |
| `rate_limit_state_size` | `trackBy`                      | Active rate-limit states.            |

### Histograms

| Metric                               | Labels      | Buckets (seconds)                             |
| ------------------------------------ | ----------- | --------------------------------------------- |
| `message_duration_seconds`           | `type`      | 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2.5, 5 |
| `storage_operation_duration_seconds` | `operation` | 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2.5, 5 |

> **Cardinality gotcha:** several metrics are labeled by `documentId` and/or
> `userId` and are never explicitly removed. Over a long-lived process with many
> distinct documents/users this grows the series set unboundedly. Keep an eye on
> it; there is currently no eviction of per-document/per-user series.

## `MetricsCollector` API

Construct with a `Registry`; it declares and registers every metric above and
exposes them as public fields (`collector.clientsActive`, `collector.messagesTotal`, …)
plus typed record helpers:

- `incrementMessage(type)` — bumps `messages_total{type}` **and** `messages_total_all`.
- `recordDocumentSize(documentId, sizeBytes, encrypted)`,
  `incrementSizeWarning(documentId)`, `incrementSizeLimitExceeded(documentId)`.
- `recordMilestoneCreated(documentId, triggerType)`,
  `recordMilestoneSoftDeleted(documentId)`, `recordMilestoneRestored(documentId)`,
  `updateMilestoneCount(documentId, lifecycleState, count)`.
- `recordRateLimitExceeded(userId, documentId?, trackBy)` — increments the
  counter and pushes onto a bounded recent-events buffer (max 100, newest first).
- `recordRateLimitDelayed(userId, documentId?, trackBy, delayMs)` — increments
  both `rate_limit_delayed_total` and `rate_limit_delay_ms_total`.
- `recordRateLimitStateOperation(operation, trackBy)`,
  `updateRateLimitStateSize(trackBy, size)`.

Aggregate readers (used by the `/status` endpoint, not Prometheus):

- `getMessageCountsByType(): Record<string, number>` — per-type message counts.
- `getRateLimitTopOffenders(limit = 10)` — offenders sorted by count, descending.
- `getRateLimitRecentEvents(limit = 10)` — newest-first slice of the ring buffer.
- `getRateLimitCountsByTrackBy(): Record<string, number>` — exceeded counts
  summed per `trackBy` dimension (across users/documents).

> The aggregate readers currently read a metric's internal `values` map via
> `as any`. It works because those counters are only ever incremented with the
> label sets these readers expect, but it is coupling worth keeping in mind if
> the primitives change.

## Usage

```typescript
import { MetricsCollector } from "teleportal/monitoring";
// The global registry is internal; import it by relative path, or supply your own.
import { Registry } from "../monitoring/metrics";

const registry = new Registry();
const collector = new MetricsCollector(registry);

collector.clientsActive.inc();
collector.recordDocumentSize("doc-1", 1024, false);
collector.incrementMessage("doc");
collector.recordRateLimitExceeded("user-1", "doc-1", "user");
collector.recordRateLimitDelayed("user-1", "doc-1", "user", 50);

const prometheusText = registry.format(); // served at /metrics
```

The server owns the process-global `register`, constructs one collector with it,
exposes the collector via `getMetricsCollector()`, and builds `StatusData` from
the aggregate readers.

## Types (`types.ts`)

- `HealthStatus` — `{ status, timestamp, checks, uptime? }`. **Shape only**; the
  server/http compute and serve it.
- `StatusData` — the `/status` payload: node id, active clients/sessions,
  message totals + per-type breakdown, document-size roll-ups, and the
  rate-limit aggregates (total, breakdown, top offenders, recent events).
- `MetricsData` — `{ prometheus: string }`.
