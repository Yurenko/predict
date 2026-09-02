import { redis } from "@/lib/db/redis";
import { childLogger } from "@/lib/logger";

export { PAPER_SKIP, paperSkipLabel } from "@/lib/paper/skip";

export const PAPER_CYCLE_KEY = "control:paper";

export interface PaperCycle {
  at: string;
  enabled: number;
  considered: number;
  filled: number;
  skip: string | null;
}

const log = childLogger({ component: "paper-cycle" });

export function parsePaperCycle(raw: string | null): PaperCycle | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PaperCycle>;
    if (!parsed || typeof parsed !== "object") return null;
    const at = typeof parsed.at === "string" ? parsed.at : "";
    if (!at) return null;
    return {
      at,
      enabled: typeof parsed.enabled === "number" ? parsed.enabled : 0,
      considered: typeof parsed.considered === "number" ? parsed.considered : 0,
      filled: typeof parsed.filled === "number" ? parsed.filled : 0,
      skip: typeof parsed.skip === "string" ? parsed.skip : null,
    };
  } catch {
    return null;
  }
}

export function newerPaperCycle(a: PaperCycle | null, b: PaperCycle | null): PaperCycle | null {
  if (!a) return b;
  if (!b) return a;
  return a.at >= b.at ? a : b;
}

export async function writePaperCycle(cycle: PaperCycle): Promise<void> {
  try {
    await redis.set(PAPER_CYCLE_KEY, JSON.stringify(cycle));
  } catch (error) {
    log.warn({ err: String(error) }, "paper cycle redis write failed");
  }
}

export async function readPaperCycle(): Promise<PaperCycle | null> {
  try {
    return parsePaperCycle(await redis.get(PAPER_CYCLE_KEY));
  } catch (error) {
    log.warn({ err: String(error) }, "paper cycle redis read failed");
    return null;
  }
}
