import { defineConfig } from "tsup";
export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  dts: true,
  target: "node22",
  clean: true,
  sourcemap: true,
  external: ["@opencode/plugin", "@opencode/plugin/*"],
});