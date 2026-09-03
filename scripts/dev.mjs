#!/usr/bin/env node
/**
 * Local dashboard. Command chooses trading mode so you don't edit .env flags.
 *   npm run dev       → PAPER (Start = virtual fills)
 *   npm run dev:live  → LIVE  (Start = real placeOrder)
 *
 * These process env vars win over .env (dotenv does not override).
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const args = process.argv.slice(2);
const live = args.includes("--live");
const nextArgs = args.filter((arg) => arg !== "--live");
const nextCli = createRequire(import.meta.url).resolve("next/dist/bin/next");

const child = spawn(process.execPath, [nextCli, "dev", ...nextArgs], {
  env: {
    ...process.env,
    LIVE_TRADING_ENABLED: live ? "true" : "false",
    TRADING_MODE: live ? "LIVE" : "PAPER",
  },
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
