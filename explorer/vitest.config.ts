import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@xtap-pool/shared": new URL("../shared/src/index.ts", import.meta.url).pathname,
    },
  },
  test: {
    name: "explorer",
    include: ["tests/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/components/ui/**", "src/main.tsx"],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 85,
        statements: 85,
      },
    },
  },
});
