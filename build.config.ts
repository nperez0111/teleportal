import { defineBuildConfig } from "obuild/config";
import * as pkg from "./package.json" with { type: "json" };

export default defineBuildConfig({
  entries: [
    {
      type: "bundle",
      input: [...inferExports(pkg.exports)],
    },
  ],
});

function inferExports(exports: Record<string, any>): string[] {
  const entries = new Set<string>();
  for (const value of Object.values(exports)) {
    if (typeof value === "string") {
      if (value.endsWith(".mjs")) {
        entries.add(value.replace("./dist", "./src").replace(".mjs", ".ts"));
      }
    } else if (typeof value === "object" && value !== null) {
      for (const entry of inferExports(value)) {
        entries.add(entry);
      }
    }
  }
  return [...entries];
}
