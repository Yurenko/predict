import { replayRawDirectory } from "@/lib/normalize/replay";
import { childLogger } from "@/lib/logger";

const log = childLogger({ component: "normalize-worker" });

export async function runNormalizeReplay(): Promise<void> {
  const stats = await replayRawDirectory();
  log.info(stats, "normalize replay complete");
}
