import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli/index.ts" },
  format: ["esm"],
  target: "node22",
  platform: "node",
  banner: { js: "#!/usr/bin/env node" },
  clean: true,
  sourcemap: false,
  dts: false,
  minify: false,
});
