# Teleportal Devtools

A comprehensive debugging and monitoring interface for Teleportal applications. The devtools module provides real-time visibility into message flow, connection state, document activity, and system statistics.

## Overview

The Teleportal Devtools is a developer tool that helps you debug and monitor your Teleportal applications by providing:

- **Real-time message monitoring**: Track all sent and received messages with detailed metadata
- **Connection state tracking**: Monitor connection status, transport type, and errors
- **Message filtering**: Filter messages by document, type, direction, and search text
- **Message inspection**: View detailed payloads, metadata, and acknowledgment status
- **Statistics**: Track message counts, rates, document counts, and message types
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
  - Top: Filters panel (collapsible)
  - Left: Message list (scrollable)
  - Right: Message inspector (fixed width)

- **State Management**: Coordinates updates between all child components

#### `FiltersPanel`

Provides filtering controls and status display:

- **Compact Header** (always visible):
  - Filters toggle button with active indicator
  - Clear filters button (when filters are active)
  - Connection status indicator with color coding
  - Document count
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
  - ACK indicator (if acknowledged)
  - Document name
  - Timestamp

- **Selection**: Clicking a message selects it and updates the inspector
- **Ordering**: Messages displayed in reverse chronological order (newest first)

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
  - Expandable section showing ACK details
  - ACK message ID (copyable)
  - Acknowledged message ID (copyable)

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

- Maintains document registry with metadata
- Tracks message counts per document
- Records last activity timestamp
- Supports provider-based filtering

#### `message-utils.ts`

Utility functions for message formatting:

- `getMessageTypeLabel()`: Extracts human-readable message type
- `getMessageTypeColor()`: Returns color class for message type badges
- `formatMessagePayload()`: Formats message payloads for display
- `formatTimestamp()`: Formats timestamps for display
- `formatRelativeTime()`: Formats relative timestamps (e.g., "5s ago")

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
        if (
          containerRef.current &&
          devtoolsRef.current.parentNode === containerRef.current
        ) {
          containerRef.current.removeChild(devtoolsRef.current);
        }
      }
    };
  }, []);

  return <div ref={containerRef} style={{ height: "100%", width: "100%" }} />;
}
```

### Custom State Management

You can provide custom state managers for advanced use cases:

```typescript
import { createTeleportalDevtools, getDevtoolsState } from "teleportal/devtools";

// Get default state
const state = getDevtoolsState();

// Or create with custom state
const customState = {
  settingsManager: new SettingsManager(),
  eventManager: new EventManager(settingsManager),
  filterManager: new FilterManager(settingsManager),
};

const devtoolsElement = createTeleportalDevtools(customState);
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

This will:

- Unsubscribe from all event listeners
- Clear internal state
- Remove event subscriptions

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
  transport: "websocket" | "http" | null;
  error?: string;
  timestamp: number;
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
