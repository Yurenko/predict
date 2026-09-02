import { redis } from "@/lib/db/redis";
import { childLogger } from "@/lib/logger";
import type { PaperAction } from "@/lib/paper/action";
import { isDuplicatePaperEnter } from "@/lib/paper/action";

export const PAPER_ENTRY_MODE_KEY = "control:paper-entry-mode";
export type PaperEntryMode = "all" | "single";
export const DEFAULT_PAPER_ENTRY_MODE: PaperEntryMode = "single";

const log = childLogger({ component: "paper-entry-mode" });

export function parsePaperEntryMode(raw: unknown): PaperEntryMode | null {
  return raw === "all" || raw === "single" ? raw : null;
}

export function shouldSkipPeerEnter(
  mode: PaperEntryMode,
  action: PaperAction,
  peerOccupied: boolean,
): boolean {
  return mode === "single" && isDuplicatePaperEnter(action, peerOccupied);
}

export async function readPaperEntryMode(): Promise<PaperEntryMode> {
  try {
    return parsePaperEntryMode(await redis.get(PAPER_ENTRY_MODE_KEY)) ?? DEFAULT_PAPER_ENTRY_MODE;
  } catch (error) {
    log.warn({ err: String(error) }, "paper entry mode redis read failed");
    return DEFAULT_PAPER_ENTRY_MODE;
  }
}

export async function writePaperEntryMode(mode: PaperEntryMode): Promise<void> {
  try {
    await redis.set(PAPER_ENTRY_MODE_KEY, mode);
  } catch (error) {
    log.warn({ err: String(error) }, "paper entry mode redis write failed");
    throw error;
  }
}
