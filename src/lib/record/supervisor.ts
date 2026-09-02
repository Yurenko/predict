import { childLogger } from "@/lib/logger";
import { runRecordLoop } from "@/lib/record/loop";
import { shouldKillExternalPid } from "@/lib/record/types";
import { readRecordControl, writeRecordControl } from "@/lib/record/control";

const log = childLogger({ component: "record-supervisor" });

const globalForLoop = globalThis as unknown as { __botpolRecordLoop?: boolean };

async function killExternalWorker(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    log.warn({ pid, err: String(error) }, "external record process kill failed");
  }
}

export function spawnRecordWorker(): { pid: number | null; error: string | null } {
  return {
    pid: process.pid,
    error: null,
  };
}

export async function ensureRecordWorker(): Promise<{
  pid: number | null;
  spawned: boolean;
  error: string | null;
}> {
  const current = await readRecordControl();
  if (shouldKillExternalPid(current.pid, process.pid)) {
    await killExternalWorker(current.pid as number);
  }

  await writeRecordControl({
    pid: process.pid,
    spawnedAt: new Date().toISOString(),
    lastError: null,
  });

  if (globalForLoop.__botpolRecordLoop) {
    return { pid: process.pid, spawned: false, error: null };
  }
  globalForLoop.__botpolRecordLoop = true;
  void runRecordLoop({ exitOnSignal: false }).catch(async (error: unknown) => {
    globalForLoop.__botpolRecordLoop = false;
    const message = error instanceof Error ? error.message : String(error);
    log.error({ err: message }, "in-process record loop crashed");
    await writeRecordControl({ lastError: message, pid: null });
  });
  log.info({ pid: process.pid }, "record loop running in the dashboard process");
  return { pid: process.pid, spawned: true, error: null };
}

export async function stopRecordWorker(): Promise<void> {
  const current = await readRecordControl();
  if (shouldKillExternalPid(current.pid, process.pid)) {
    await killExternalWorker(current.pid as number);
  }
  await writeRecordControl({ pid: null });
}
