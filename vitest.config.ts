import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@xtap-pool/shared": new URL("./shared/src/index.ts", import.meta.url).pathname,
    },
  },
  test: {
    projects: [
      "shared/vitest.config.ts",
      "space/vitest.config.ts",
      "explorer/vitest.config.ts",
      "setup/vitest.config.ts",
    ],
    coverage: {
      provider: "v8",
      include: ["shared/src/**", "space/src/**", "explorer/src/**", "setup/src/**"],
      exclude: [
        "explorer/src/components/ui/**",
        "explorer/src/main.tsx",
        "setup/src/deploy.ts",
        "setup/src/main.ts",
        "setup/src/wizard.ts",
        "space/src/server.ts",
      ],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 85,
        statements: 85,
      },
    },
  },
});
