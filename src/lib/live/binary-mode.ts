import { redis } from "@/lib/db/redis";
import { childLogger } from "@/lib/logger";
import type { PaperAction } from "@/lib/paper/action";

/** v2: old `control:live-binary-mode=independent` must not override Paper-style flip. */
export const LIVE_BINARY_MODE_KEY = "control:live-binary-mode.v2";
export const LIVE_BINARY_MODE_KEY_LEGACY = "control:live-binary-mode";
export type LiveBinaryMode = "independent" | "flip";
export const DEFAULT_LIVE_BINARY_MODE: LiveBinaryMode = "flip";

const log = childLogger({ component: "live-binary-mode" });

export function parseLiveBinaryMode(raw: unknown): LiveBinaryMode | null {
  return raw === "independent" || raw === "flip" ? raw : null;
}

/** PAPER-style: opposite signal closes the held leg first. Down opens only after that leg is gone. */
export function liveOppositeCloses(mode: LiveBinaryMode): boolean {
  return mode === "flip";
}

/**
 * Flip ENTER must wait until the previous leg is actually closed.
 * Inflight EXIT on the other token would otherwise let Down open at the same time as leftover Up.
 */
export function shouldBlockLiveFlipEnter(options: {
  mode: LiveBinaryMode;
  action: PaperAction;
  stillOpen: boolean;
  inflightOnMarket: boolean;
}): boolean {
  if (options.mode !== "flip" || options.action !== "ENTER") return false;
  return options.stillOpen || options.inflightOnMarket;
}

export async function readLiveBinaryMode(): Promise<LiveBinaryMode> {
  try {
    const stored = parseLiveBinaryMode(await redis.get(LIVE_BINARY_MODE_KEY));
    await redis.del(LIVE_BINARY_MODE_KEY_LEGACY);
    const mode = stored ?? DEFAULT_LIVE_BINARY_MODE;
    if (!stored) {
      await redis.set(LIVE_BINARY_MODE_KEY, mode);
    }
    return mode;
  } catch (error) {
    log.warn({ err: String(error) }, "live binary mode redis read failed");
    return DEFAULT_LIVE_BINARY_MODE;
  }
}

export async function writeLiveBinaryMode(mode: LiveBinaryMode): Promise<void> {
  try {
    await redis.set(LIVE_BINARY_MODE_KEY, mode);
    await redis.del(LIVE_BINARY_MODE_KEY_LEGACY);
  } catch (error) {
    log.warn({ err: String(error) }, "live binary mode redis write failed");
    throw error;
  }
}
