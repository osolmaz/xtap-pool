import { defineConfig } from "vitest/config";

export default defineConfig({
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
