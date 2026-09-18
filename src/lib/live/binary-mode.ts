import { env } from "@/lib/config/env";
import { redis } from "@/lib/db/redis";
import { childLogger } from "@/lib/logger";
import type { PaperAction } from "@/lib/paper/action";

/** LIVE defaults to Paper-style flip: opposite signal closes the held leg first. */
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
 * Next-cycle ENTER still waits for OPEN to clear (venue-flat / close),
 * like Paper waiting for the EXIT fill.
 */
export function shouldBlockLiveFlipEnter(options: {
  mode: LiveBinaryMode;
  action: PaperAction;
  stillOpen: boolean;
  inflightOnMarket: boolean;
  leftoverGone?: boolean;
}): boolean {
  if (options.mode !== "flip" || options.action !== "ENTER") return false;
  if (options.leftoverGone) return false;
  return options.stillOpen || options.inflightOnMarket;
}

/**
 * Paper/Live flip keeps emitting until endDate so a 1m-reversal leg can
 * flatten back to the candle. A first ENTER on an empty market still uses
 * the strategy's normal minTimeToExpirySec (usually 60s).
 */
export function liveStrategyParams(options: {
  parameters: Record<string, unknown>;
  keepSignallingNearExpiry: boolean;
}): Record<string, unknown> {
  if (!options.keepSignallingNearExpiry) return { ...options.parameters };
  return { ...options.parameters, minTimeToExpirySec: 0 };
}

export async function readLiveBinaryMode(): Promise<LiveBinaryMode> {
  const fromEnv = parseLiveBinaryMode(env.LIVE_BINARY_MODE);
  try {
    if (fromEnv) {
      await redis.set(LIVE_BINARY_MODE_KEY, fromEnv);
      await redis.del(LIVE_BINARY_MODE_KEY_LEGACY);
      return fromEnv;
    }
    const stored = parseLiveBinaryMode(await redis.get(LIVE_BINARY_MODE_KEY));
    await redis.del(LIVE_BINARY_MODE_KEY_LEGACY);
    const mode = stored ?? DEFAULT_LIVE_BINARY_MODE;
    if (!stored) {
      await redis.set(LIVE_BINARY_MODE_KEY, mode);
    }
    return mode;
  } catch (error) {
    log.warn({ err: String(error) }, "live binary mode redis read failed");
    return fromEnv ?? DEFAULT_LIVE_BINARY_MODE;
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
