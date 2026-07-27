import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@xtap-pool/shared": new URL("../shared/src/index.ts", import.meta.url).pathname,
    },
  },
  test: {
    name: "space",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/server.ts", "src/enrich-command.ts", "src/enrich-command-main.ts"],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 85,
        statements: 85,
      },
    },
  },
});
