import type { BunPlugin } from "bun";
import path from "path";

// Bun bundler plugin that makes `pica` resolution deterministic.
//
// `pica` (7.1.1) ships only a UMD build (`dist/pica.js`) whose module export is
// a bare constructor function. `@excalidraw/excalidraw` consumes it via a
// dynamic `import("pica")` and reads `.default`. Under Bun's dev server
// (HTML + HMR) the CJS -> ESM interop for that transitive dynamic import is
// racy: on a cold first image insert `.default` can come back non-callable,
// producing `TypeError: pica is not a function`.
//
// tsconfig `paths` cannot fix this because they only rewrite imports for files
// inside the project's `include` scope -- excalidraw's internal `import("pica")`
// lives in node_modules and is never rewritten. A bundler `onResolve` hook,
// however, runs for *every* import (including those from node_modules), so we
// redirect the bare `pica` specifier to our shim which normalizes the default
// export into a stable, callable function.
const picaShim = path.join(import.meta.dir, "src", "pica-shim.ts");

export const picaPlugin: BunPlugin = {
  name: "pica-interop",
  setup(build) {
    build.onResolve({ filter: /^pica$/ }, () => ({ path: picaShim }));
  },
};

export default picaPlugin;
