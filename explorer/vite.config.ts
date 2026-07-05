import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    alias: {
      "@xtap-pool/shared": new URL("../shared/src/index.ts", import.meta.url).pathname,
    },
  },
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": "http://localhost:7860",
      "/oauth": "http://localhost:7860",
      "/connect": "http://localhost:7860",
    },
  },
});
