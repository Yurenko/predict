import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    env: {
      LIVE_TRADING_ENABLED: "false",
      TRADING_MODE: "PAPER",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(root, "src"),
    },
  },
});
