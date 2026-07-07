# Teleportal Devtools

A comprehensive debugging and monitoring interface for Teleportal applications. The devtools module provides real-time visibility into message flow, connection state, document activity, and system statistics.

## Overview

The Teleportal Devtools is a developer tool that helps you debug and monitor your Teleportal applications. The UI is organized into three tabs — **Messages**, **Documents**, and **Presence** — plus an always-visible connection status area with a details popover:

- **Real-time message monitoring**: Track all sent and received messages with detailed metadata
- **RPC call grouping**: RPC request/stream/response messages collapse into one call row with status, latency, and error details; file uploads/downloads show live chunk progress
- **ACK latency**: Acknowledged messages show their round-trip time, color-coded against the in-flight timeout
- **Update operations decoder**: `update`/`sync-step-2` payloads are decoded into human-readable ops (`insert "hel" @ (client, clock) in body`), including for encrypted documents when the key is available
- **Documents tab**: Tree of documents and subdocuments with live sync handshake state (sync-step-1 → sync-step-2 → synced), traffic counters, encryption, and last activity; click a document to filter the Messages tab
- **Presence tab**: Live peer roster from presence-join/leave/heartbeat messages with expandable per-peer data and a recent join/leave feed
- **Connection popover**: Click the connection status for live internals — in-flight/buffered counts, AIMD batch window, reconnect attempts, SharedWorker pooling details (tabs, key, grace period, heartbeat), and a timeline of state transitions, transport fallbacks/upgrades, and token refreshes
- **Message filtering**: Filter messages by document, type, direction, and search text
- **Message inspection**: View detailed payloads, metadata, and acknowledgment status
- **Persistent settings**: Settings are saved to localStorage and persist across sessions

## Architecture

The devtools module is built with a modular architecture consisting of several key components:

### Core Managers

#### `EventManager`

The central component that listens to Teleportal events and maintains state:

- **Event Listening**: Subscribes to `teleportalEventClient` events:
  - `received-message`: Captures incoming messages
  - `sent-message`: Captures outgoing messages
  - `connected`/`disconnected`/`update`: Tracks connection state changes
  - `load-subdoc`/`unload-subdoc`: Tracks document lifecycle

- **Message Tracking**:
  - Maintains a list of messages with metadata (ID, direction, timestamp, document, provider)
  - Tracks ACK messages and links them to their corresponding messages
  - Enforces message limit to prevent memory issues
  - Deduplicates messages by ID

- **Statistics Calculation**:
  - Total message count
  - Messages by type
  - Sent vs received counts
  - Message rate (messages per second over last 10 seconds)
  - Document count
  - Connection state

- **Document Tracking**: Uses `DocumentTracker` to maintain document state and activity

#### `FilterManager`

Manages message filtering logic:

- **Filter Types**:
  - Document filter: Show messages from specific documents
  - Message type filter: Hide/show specific message types
  - Direction filter: Filter by sent/received/all
  - Search filter: Text search across message payloads and document IDs

- **Filter State**: Automatically excludes ACK messages from the display list (they're tracked separately)

#### `SettingsManager`

Manages persistent settings:

- **Settings**:
  - `messageLimit`: Maximum number of messages to keep in memory (default: 200)
  - `filters`: Current filter state

- **Persistence**: Settings are saved to `localStorage` with key `teleportal-devtools-settings`
- **Backward Compatibility**: Supports migration from legacy `teleportal-devtools-message-limit` key

### UI Components

#### `DevtoolsLayout`

The main layout component that orchestrates the UI:

- **Layout Structure**:
  - Header bar: tab bar (Messages / Documents / Presence) + connection status with popover trigger
  - Messages tab: collapsible filters row, message list (left), message inspector (right)
  - Documents tab: document tree panel
  - Presence tab: peer roster panel

- **State Management**: Coordinates updates between all child components

#### `TabBar` and `ConnectionStatus`

The header bar. `TabBar` switches between the three views and shows count badges (document count, peer count). `ConnectionStatus` shows the live state dot, hosting badge (`[direct]`/`[worker]`), transport selector, error, and relative timestamp; clicking it opens the `ConnectionPopover`.

#### `ConnectionPopover`

Anchored panel with connection internals, refreshed every second while open:

- **Connection stats**: state, transports, uptime, sent/received counts, in-flight and buffered message counts, AIMD batch window, reconnect attempts, online state (via `connection.diagnostics`)
- **SharedWorker section** (worker hosting only): tabs sharing the connection, pooling key, grace period, tab↔worker heartbeat health
- **Timeline**: state transitions with durations, transport fallback/upgrade probes, token refreshes (scheduled and reactive), reconnect scheduling — sourced from connection `diagnostic` events and recorded in a ring buffer

#### `FiltersPanel`

Provides filtering controls for the Messages tab:

- **Compact Header** (always visible):
  - Filters toggle button with active indicator
  - Clear filters button (when filters are active)
  - Message limit input

- **Expandable Filter Content**:
  - Search input with debouncing (300ms)
  - Direction selector (all/sent/received)
  - Document checkboxes (multi-select)
  - Message type checkboxes (hide/show specific types)

#### `MessageList`

Displays a scrollable list of filtered messages:

- **Message Items**: Each item shows:
  - Direction icon (sent/received)
  - Message type badge with color coding
  - ACK latency badge (if acknowledged) — green/amber/red against the 30s in-flight timeout
  - Document name
  - Timestamp

- **RPC grouping**: RPC messages collapse into one call row per `originalRequestId` (`RpcTracker` pairs requests, streamed parts, and responses; file transfer streams are paired via their fileId). The row shows a status pill (pending spinner / streaming / latency / error code) and, for file transfers, a chunk progress bar. Expanding reveals the member messages chronologically. Upload chunks deliberately never appear as messages — they stay off the event pipeline for throughput — so upload progress and completion come from the file protocol's progress events (`onFileTransferProgress`); download parts arrive as received messages and are grouped normally.
- **Selection**: Clicking a message (or call row) selects it and updates the inspector
- **Ordering**: Messages displayed in reverse chronological order (newest first); call rows are anchored at the call's start

#### `DocumentsPanel`

Tree of main documents and their subdocuments (from `load-subdoc`/`unload-subdoc` events):

- Sync handshake stepper per document (sync-step-1 → sync-step-2 → synced), derived live from the message stream and reset on disconnect
- Message count, sent/received bytes, encryption lock, last activity
- Clicking a document applies it as a Messages-tab filter

#### `PresencePanel`

Live peer roster derived from cleartext presence messages:

- One row per peer: color dot (stable per userId), userId, clientId, awareness id, joined time; click to expand the integrator-supplied `data` blob
- Heartbeat rosters upsert peers without evicting peers from other nodes
- Recent join/leave feed below the roster; the roster clears on disconnect

#### `MessageInspector`

Detailed view of a selected message:

- **Metadata Section**:
  - Message ID (copyable)
  - Direction badge
  - Type badge with color coding
  - Document ID (copyable)
  - Timestamp (copyable, ISO format)
  - Encryption status indicator

- **ACK Section** (if applicable):
  - Expandable section showing ACK details with the round-trip latency
  - ACK message ID (copyable)
  - Acknowledged message ID (copyable)

- **Operations Section** (doc `update`/`sync-step-2` messages):
  - The Y.js update decoded into readable ops: inserts with content and location (`+ insert "hi" @ (client, clock) in body`), map sets, format changes, shared type creation, and delete-set ranges
  - Works on encrypted documents too — the payload is decrypted and content-restored first when the provider has the key

- **RPC Call view** (when a call row is selected):
  - Method, status pill, latency/duration, request id, message counts
  - File transfer summary with progress bar, chunk/byte counters, and merkle/encryption metadata
  - Request and response payloads side by side; full error details for failed calls

- **Payload Section**:
  - Formatted message payload
  - Copy button for easy clipboard access
  - Special formatting for different message types:
    - Document messages: Base64 encoded updates
    - Awareness messages: Decoded client states
    - File messages: JSON formatted metadata
    - ACK messages: Simplified format

### Utilities

#### `DocumentTracker`

Tracks document state and activity:

- Maintains document registry with metadata, including parent/subdocument links
- Derives the sync handshake phase per document from the message stream
- Tracks message counts and sent/received bytes per document
- Records encryption and last activity timestamp

#### `RpcTracker` (`rpc-tracker.ts`)

Pure derivation that groups the rpc messages of a message list into logical calls (`buildRpcGroups`): pairs responses/streams to requests by `originalRequestId`, aliases file transfer streams via their fileId, and computes status, latency, and chunk progress. Takes an optional live transfer-progress map (from `onFileTransferProgress` in `teleportal/protocols/file`) that supplies chunk counts and completion state for uploads, whose chunk messages are never visible.

#### `PresenceTracker` (`presence-tracker.ts`)

Stateful roster fed by presence messages: join/leave maintenance, heartbeat upserts, and a bounded join/leave feed.

#### `update-decoder.ts`

Decodes Y.js updates into human-readable operations (`decodeUpdateOps`, `formatUpdateOp`) — inserts with content previews, map keys, origins, and delete-set ranges. Used by the inspector's Operations section.

#### `message-utils.ts`

Utility functions for message formatting:

- `getMessageTypeLabel()`: Extracts human-readable message type
- `getMessageTypeColor()`: Returns color class for message type badges
- `formatMessagePayload()`: Formats message payloads for display
- `decryptContentPayload()`: Decrypts a content-encrypted doc payload into a plaintext V2 update
- `formatTimestamp()` / `formatRelativeTime()` / `formatDuration()` / `formatBytes()`: Display formatting helpers
- `getAckLatencyLevel()`: Buckets ACK round-trips against the in-flight timeout

## Usage

### Basic Integration

```typescript
import { createTeleportalDevtools } from "teleportal/devtools";

// Create the devtools element
const devtoolsElement = createTeleportalDevtools();

// Append to your DOM
document.body.appendChild(devtoolsElement);
```

### React Integration

```tsx
import { useState, useEffect, useRef } from "react";
import { createTeleportalDevtools, getDevtoolsState } from "teleportal/devtools";

export function TeleportalDevtoolsPanel() {
  const containerRef = useRef<HTMLDivElement>(null);
  const devtoolsRef = useRef<HTMLElement | null>(null);
  const [state] = useState(() => getDevtoolsState());

  useEffect(() => {
    if (!containerRef.current) return;

    // Create the devtools element
    const devtoolsElement = createTeleportalDevtools(state);
    containerRef.current.appendChild(devtoolsElement);
    devtoolsRef.current = devtoolsElement;

    // Cleanup on unmount
    return () => {
      if (devtoolsRef.current) {
        const cleanup = (devtoolsRef.current as any).__teleportalDevtoolsCleanup;
        if (cleanup) {
          cleanup();
        }
        if (containerRef.current && devtoolsRef.current.parentNode === containerRef.current) {
          containerRef.current.removeChild(devtoolsRef.current);
        }
      }
    };
  }, []);

  return <div ref={containerRef} style={{ height: "100%", width: "100%" }} />;
}
```

### State Persistence Across Close/Open

`getDevtoolsState()` returns a **shared singleton**: it is created on first call and keeps collecting messages, documents, presence, and the connection timeline in the background — even while the panel is closed (memory bounded by the message limit). Reopening the devtools therefore shows history instead of starting empty.

- Closing the panel (`__teleportalDevtoolsCleanup`) detaches the UI only; collection continues.
- `destroyDevtoolsState()` stops collection entirely and drops history.
- `createDevtoolsState()` creates a fresh, isolated state for advanced cases where you don't want the shared instance (you then own its lifecycle and must call `eventManager.destroy()` yourself).

```typescript
import {
  createTeleportalDevtools,
  getDevtoolsState,
  createDevtoolsState,
  destroyDevtoolsState,
} from "teleportal/devtools";

// Shared state — survives panel close/open
const devtoolsElement = createTeleportalDevtools(getDevtoolsState());

// Isolated state — caller-owned lifecycle
const isolated = createDevtoolsState();
const el = createTeleportalDevtools(isolated);
// ...later: isolated.eventManager.destroy();

// Stop background collection entirely
destroyDevtoolsState();
```

## Message Types

The devtools recognizes and color-codes various message types:

### Document Messages

- `sync-step-1`: Initial sync step (blue)
- `sync-step-2`: Second sync step (darker blue)
- `update`: Document update (green)
- `sync-done`: Sync completion (darker green)
- `auth-message`: Authentication message (red)
- `milestone-*`: Milestone-related messages (purple)

### Awareness Messages

- `awareness-update`: Awareness state update (yellow)
- `awareness-request`: Awareness state request (darker yellow)

### File Messages

- `file-upload`: File upload (indigo)
- `file-download`: File download (darker indigo)
- `file-part`: File chunk (lighter indigo)
- `file-auth-message`: File authentication (red)

### ACK Messages

- `ack`: Acknowledgment messages (gray, hidden from list but tracked)

## Connection States

The devtools tracks connection states with visual indicators:

- **Connected** (green): Active WebSocket connection
- **Connecting** (yellow): Connection in progress
- **Disconnected** (gray): No active connection
- **Errored** (red): Connection error occurred

## Filtering

### Document Filter

Select one or more documents to show only messages from those documents. Documents are automatically discovered from incoming messages.

### Message Type Filter

Hide specific message types from the list. Useful for focusing on specific message categories (e.g., hiding all awareness updates).

### Direction Filter

Filter messages by direction:

- **All**: Show both sent and received messages
- **Sent**: Show only outgoing messages
- **Received**: Show only incoming messages

### Search Filter

Search across message payloads and document IDs. The search is case-insensitive and uses a 300ms debounce for performance.

## Settings

### Message Limit

Controls the maximum number of messages kept in memory. When the limit is exceeded, older messages are automatically removed. Default: 200 messages.

### Filter Persistence

All filter settings are automatically saved to localStorage and restored on page reload.

## Cleanup

The devtools provides a cleanup function to properly dispose of resources:

```typescript
const devtoolsElement = createTeleportalDevtools();

// Later, when cleaning up:
const cleanup = (devtoolsElement as any).__teleportalDevtoolsCleanup;
if (cleanup) {
  cleanup();
}
```

This detaches the UI (unsubscribes the render listeners and destroys the layout). It does **not** stop the shared state from collecting — call `destroyDevtoolsState()` for a full teardown.

## Styling

The devtools uses scoped CSS classes prefixed with `devtools-` to avoid conflicts with your application styles. Styles are automatically injected into the document head when the devtools is created.

## Event System

The devtools integrates with Teleportal's event system through `teleportalEventClient` from `teleportal/providers`. It listens to:

- `received-message`: When a message is received
- `sent-message`: When a message is sent
- `connected`: When connection is established
- `disconnected`: When connection is lost
- `update`: When connection state updates
- `load-subdoc`: When a subdocument is loaded
- `unload-subdoc`: When a subdocument is unloaded

## Performance Considerations

- **Message Limit**: The default limit of 200 messages prevents memory issues. Adjust based on your needs.
- **Debounced Search**: Search input is debounced by 300ms to avoid excessive filtering operations.
- **Efficient Rendering**: Components only re-render when their specific data changes.
- **Deduplication**: Messages are deduplicated by ID to prevent duplicate entries.

## Type Definitions

Key types exported from the devtools module:

```typescript
type DevtoolsMessage = {
  id: string;
  message: Message | RawReceivedMessage;
  direction: "sent" | "received";
  timestamp: number;
  document: string | undefined;
  provider: Provider;
  connection: any;
  ackedBy?: {
    ackMessageId: string;
    ackMessage: Message | RawReceivedMessage;
    timestamp: number;
  };
};

type ConnectionStateInfo = {
  type: "connected" | "connecting" | "disconnected" | "errored";
  hosting?: "direct" | "worker";
  transport: string | null;
  availableTransports: string[];
  error?: string;
  timestamp: number;
};

type DocumentState = {
  id: string;
  name: string;
  provider: Provider;
  parentId?: string;
  isSubdoc: boolean;
  encrypted: boolean;
  syncPhase: "idle" | "sync-step-1" | "sync-step-2" | "synced";
  messageCount: number;
  bytesSent: number;
  bytesReceived: number;
  lastActivity: number;
};

type ConnectionTimelineEntry = {
  timestamp: number;
  kind: "connected" | "connecting" | "disconnected" | "errored" | "info" | "warn";
  label: string;
  detail?: string;
};

type Statistics = {
  totalMessages: number;
  messagesByType: Record<string, number>;
  sentCount: number;
  receivedCount: number;
  connectionState: ConnectionStateInfo | null;
  documentCount: number;
  messageRate: number; // messages per second
};

type FilterState = {
  documentIds: string[];
  hiddenMessageTypes: string[];
  direction: "all" | "sent" | "received";
  searchText: string;
};
```

## Examples

See the playground application (`playground/src/devtools/index.tsx`) for a complete React integration example.
