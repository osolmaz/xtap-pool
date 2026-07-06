import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "setup",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/main.ts", "src/wizard.ts", "src/deploy.ts"],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 85,
        statements: 85,
      },
    },
  },
});
