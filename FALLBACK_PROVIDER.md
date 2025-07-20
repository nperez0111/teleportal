# Fallback Provider

The Teleportal provider now includes automatic fallback functionality that tries to establish a WebSocket connection first and gracefully falls back to HTTP/SSE if WebSocket connections are blocked or fail.

## Features

- **Automatic Fallback**: Tries WebSocket first, falls back to HTTP/SSE seamlessly
- **Transparent API**: Users don't need to change existing code
- **Enterprise-Friendly**: Works in corporate networks that block WebSocket connections
- **Configurable Timeouts**: Customize how long to wait before falling back
- **Connection Type Detection**: Know which connection type is being used

## Basic Usage

### Simple Case (Recommended)

```typescript
import { Provider } from "teleportal/providers";

// Create a provider that will automatically try WebSocket first, then HTTP
const provider = await Provider.create({
  url: "https://your-server.com",
  document: "my-document",
});

// Check which connection type is being used
console.log(`Connected via: ${provider.connectionType}`); // "websocket" or "http"
```

### With Custom Options

```typescript
const provider = await Provider.create({
  url: "https://your-server.com",
  document: "my-document",
  
  // Fallback configuration
  websocketTimeout: 5000, // Wait 5 seconds before falling back (default: 5000ms)
  
  // WebSocket-specific options
  websocketOptions: {
    protocols: ["teleportal"],
    WebSocket: CustomWebSocketImpl, // Custom WebSocket implementation
  },
  
  // HTTP-specific options  
  httpOptions: {
    fetch: customFetch, // Custom fetch implementation
    EventSource: CustomEventSource, // Custom EventSource implementation
  },
});
```

## Use Cases

### Corporate Networks

Many enterprise networks block WebSocket connections for security reasons. The fallback provider automatically detects this and switches to HTTP/SSE:

```typescript
// This will work even if WebSockets are blocked
const provider = await Provider.create({
  url: "https://your-corporate-app.com",
  document: "team-document",
  websocketTimeout: 3000, // Fail fast in corporate environments
});

// Will be "http" if WebSockets are blocked, "websocket" if they work
console.log(`Using ${provider.connectionType} connection`);
```

### Progressive Enhancement

Start with the best connection type and gracefully degrade:

```typescript
const provider = await Provider.create({
  url: process.env.SERVER_URL,
  document: "collaborative-doc",
});

// Inform users about connection quality
if (provider.connectionType === "websocket") {
  showNotification("Real-time collaboration enabled", "success");
} else {
  showNotification("Collaboration enabled (compatibility mode)", "info");
}
```

## Advanced Usage

### Using Specific Connection Types

If you want to use a specific connection type instead of the fallback:

```typescript
import { WebSocketConnection, HttpConnection } from "teleportal/providers";

// Force WebSocket only
const wsProvider = await Provider.create({
  client: new WebSocketConnection({ url: "ws://localhost:1234" }),
  document: "my-doc",
});

// Force HTTP only  
const httpProvider = await Provider.create({
  client: new HttpConnection({ url: "http://localhost:1234" }),
  document: "my-doc",
});
```

### Custom Fallback Connection

You can also use the `FallbackConnection` directly:

```typescript
import { FallbackConnection, Provider } from "teleportal/providers";

const connection = new FallbackConnection({
  url: "https://your-server.com",
  websocketTimeout: 2000,
  websocketOptions: {
    protocols: ["custom-protocol"],
  },
});

const provider = await Provider.create({
  client: connection,
  document: "my-document",
});
```

## Migration Guide

### From WebSocket Provider

**Before:**
```typescript
import { websocket } from "teleportal/providers";

const provider = await websocket.Provider.create({
  url: "ws://localhost:1234",
  document: "my-doc",
});
```

**After:**
```typescript
import { Provider } from "teleportal/providers";

const provider = await Provider.create({
  url: "http://localhost:1234", // Note: use http/https URL, WebSocket URL will be auto-generated
  document: "my-doc",
});
```

### Backward Compatibility

The old APIs still work:

```typescript
// Still works - WebSocket only
import { websocket } from "teleportal/providers";
const wsProvider = await websocket.Provider.create({
  url: "ws://localhost:1234",
  document: "my-doc",
});

// Still works - HTTP only
import { http } from "teleportal/providers";
const httpProvider = await http.Provider.create({
  client: new http.HttpConnection({ url: "http://localhost:1234" }),
  document: "my-doc",
});
```

## Configuration Options

### FallbackConnectionOptions

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `url` | `string` | required | Base URL for connections |
| `websocketTimeout` | `number` | `5000` | Timeout for WebSocket connection attempts (ms) |
| `websocketOptions` | `object` | `{}` | WebSocket-specific options |
| `websocketOptions.protocols` | `string[]` | `undefined` | WebSocket protocols |
| `websocketOptions.WebSocket` | `WebSocket` | `WebSocket` | Custom WebSocket implementation |
| `httpOptions` | `object` | `{}` | HTTP-specific options |
| `httpOptions.fetch` | `function` | `fetch` | Custom fetch implementation |
| `httpOptions.EventSource` | `EventSource` | `EventSource` | Custom EventSource implementation |

### Provider.create() Options

All the above options plus standard provider options:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `document` | `string` | required | Document name |
| `ydoc` | `Y.Doc` | `new Y.Doc()` | Y.js document instance |
| `awareness` | `Awareness` | `new Awareness()` | Y.js awareness instance |
| `enableOfflinePersistence` | `boolean` | `true` | Enable IndexedDB persistence |
| `indexedDBPrefix` | `string` | `"teleportal-"` | IndexedDB storage prefix |

## Connection States

The provider exposes connection state information:

```typescript
const provider = await Provider.create({
  url: "https://your-server.com",
  document: "my-doc",
});

// Check connection type
console.log(provider.connectionType); // "websocket" | "http" | null

// Listen for connection changes
provider.on("update", (state) => {
  console.log("Connection state:", state.type);
  if (state.type === "connected") {
    console.log("Connected via:", provider.connectionType);
  }
});
```

## Error Handling

```typescript
try {
  const provider = await Provider.create({
    url: "https://your-server.com",
    document: "my-doc",
    websocketTimeout: 3000,
  });
  
  console.log(`Successfully connected via ${provider.connectionType}`);
} catch (error) {
  console.error("Both WebSocket and HTTP connections failed:", error);
  // Handle connection failure
}
```

## Best Practices

1. **Use reasonable timeouts**: 3-5 seconds is usually sufficient for WebSocket attempts
2. **Handle both connection types**: Your app should work well with both WebSocket and HTTP connections
3. **Inform users**: Let users know which connection type is being used
4. **Test in corporate environments**: Ensure your app works when WebSockets are blocked
5. **Monitor connection types**: Track which connection types your users are actually using

## Examples

See `example-fallback.ts` for a complete working example.

## Troubleshooting

### WebSocket Never Falls Back to HTTP

- Check that `websocketTimeout` is set to a reasonable value (not too high)
- Ensure the server supports both WebSocket and HTTP/SSE endpoints
- Verify that the base URL is correct (use http/https, not ws/wss)

### HTTP Connection Fails

- Ensure the server has HTTP/SSE endpoints configured
- Check CORS settings for cross-origin requests
- Verify that EventSource is available in your environment

### Both Connections Fail

- Check network connectivity
- Verify server is running and accessible
- Check browser console for specific error messages
- Ensure server supports the Teleportal protocol