import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["shared/vitest.config.ts", "space/vitest.config.ts", "explorer/vitest.config.ts"],
    coverage: {
      provider: "v8",
      include: ["shared/src/**", "space/src/**", "explorer/src/**"],
      exclude: ["explorer/src/components/ui/**", "explorer/src/main.tsx", "space/src/server.ts"],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 85,
        statements: 85,
      },
    },
  },
});
