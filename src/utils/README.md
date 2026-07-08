# `teleportal/utils`

Tiny, dependency-free primitives shared across the codebase: byte<->string
encoding (base64 / base64url / hex) and runtime detection. Everything here is
runtime-agnostic and picks the fastest implementation available for the host.

## Why it exists

Teleportal runs in Node, Bun, browsers, and Cloudflare Workers. These helpers
paper over the fact that `Buffer` exists on the server but not the browser, and
that base64url (used in URLs and JWT-adjacent identifiers) is not natively
supported everywhere. Keeping them in one place means the rest of the codebase
encodes bytes the same way regardless of runtime.

## Runtime detection (`environment.ts`)

- `isNode` — `true` when `process.versions.node` is present. True in both Node
  and Bun (Bun implements the `node:` compatibility surface).
- `isBrowser` — `true` when `globalThis.navigator` exists **and** `isNode` is
  false. The `!isNode` guard matters: modern Node (>= 21) and Bun both define
  `navigator`, so a bare `navigator` check would misclassify them as browsers.

These flags are evaluated once at module load. `buffer.ts` uses `isBrowser` to
select its encoder at import time (no per-call branch).

## Byte encoding (`buffer.ts`)

Base64 has two implementations chosen by `isBrowser`:

- **Server (`isBrowser === false`):** `Buffer.from(...).toString("base64")` /
  `Buffer.from(s, "base64")`. Uses the Uint8Array's `buffer`/`byteOffset`/
  `byteLength` so it works correctly on subarray views.
- **Browser:** `btoa`/`atob` over a `String.fromCharCode` byte string.

### Exports

- `toBase64(bytes): string` / `fromBase64(s): Uint8Array` — standard base64
  (with `+`, `/`, `=` padding).
- `toBase64UrlEncoded(bytes): string` — base64url: `+`->`-`, `/`->`_`, padding
  stripped. Safe in URLs and path segments.
- `fromBase64UrlEncoded(s): Uint8Array` — inverse: restores `-`->`+`, `_`->`/`,
  and re-pads to a multiple of 4 before decoding. Accepts input with or without
  padding.
- `toHexString(bytes): string` — lowercase, zero-padded hex (two chars per byte;
  `""` for an empty array).

## Consumption

Import from the package entry, which re-exports both modules:

```ts
import { toBase64, fromBase64, toHexString, isNode, isBrowser } from "teleportal/utils";
```

`toBase64`/`fromBase64` are used pervasively for encoding chunk hashes, file
ids, and storage keys (storage adapters, transports, file protocols, devtools).
`toBase64UrlEncoded` is used where the value ends up in a URL. `toHexString`
backs IndexedDB key derivation.

## Gotchas

- The base64 backend is fixed at **import time** from `isBrowser`; there is no
  per-call override. Code that must behave identically cross-runtime should rely
  on the round-trip (`fromBase64(toBase64(x)) === x`), which holds on all
  supported runtimes.
- `fromBase64UrlEncoded` only decodes the **base64url** alphabet. Feeding it a
  standard base64 string containing `+` or `/` will corrupt the result — use
  `fromBase64` for standard base64.
- `toBase64Browser`/`fromBase64Browser` assume byte values (0-255); they are not
  general text encoders.

## Files

- `environment.ts` - `isNode` / `isBrowser` runtime detection.
- `buffer.ts` - base64 / base64url / hex encoders, runtime-selected.
- `index.ts` - public re-exports.
- `utils.test.ts` - round-trip and edge-case tests (empty, all 256 byte values,
  padding boundaries, url-safe alphabet).
