// Deterministic pica interop shim.
//
// `pica` (7.1.1) ships only a UMD build (`dist/pica.js`) whose module export is
// a bare constructor function. `@excalidraw/excalidraw` consumes it via a
// dynamic `import("pica")` and reads `.default`. Under Bun's dev server
// (HTML + HMR), the CJS -> ESM interop for that dynamic import is racy: on a
// cold first image insert `.default` can come back non-callable, producing
// `TypeError: pica is not a function`.
//
// The `pica-interop` bundler plugin (see ../pica-plugin.ts) redirects the bare
// `pica` specifier to this shim so excalidraw's dynamic import resolves here
// instead. Importing the UMD entry explicitly and re-exporting a normalized
// default gives a stable, callable export in both the dev server and the
// production bundle.
import * as picaModule from "pica/dist/pica.js";

const pica = (picaModule as { default?: unknown }).default ?? (picaModule as unknown);

export default pica as (...args: unknown[]) => unknown;
