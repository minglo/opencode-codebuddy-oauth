import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  dts: true,
  sourcemap: true,
  clean: true,
  // 宿主提供，不打包
  deps: { neverBundle: ["@opencode/plugin", /^@opencode\/plugin\//] },
  // tsdown 默认 .mjs/.d.mts，package.json exports 指向 .js/.d.ts
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
});
