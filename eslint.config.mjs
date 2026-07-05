import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "eslint.config.mjs",
      "**/dist/**",
      "**/dist-types/**",
      "**/coverage/**",
      "**/node_modules/**",
      "extension/**",
      "explorer/vite.config.ts",
      "**/vitest.config.ts",
      "stryker.conf.json",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],
      complexity: ["error", 8],
    },
  },
);
