#!/usr/bin/env node
/**
 * One-off production migrate. Never runs `prisma migrate dev`.
 */
import { spawnSync } from "node:child_process";

const result = spawnSync("npx", ["prisma", "migrate", "deploy"], {
  stdio: "inherit",
  shell: true,
});

process.exit(result.status ?? 1);
