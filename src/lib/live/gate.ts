import { isLiveTradingEnabled } from "@/lib/config/env";
import { TradingMode } from "@prisma/client";

export function assertLiveExecution(mode: TradingMode): void {
  if (mode !== TradingMode.LIVE) {
    throw new Error("executeLiveTrade is LIVE-only; paper fills belong in the paper worker");
  }
  if (!isLiveTradingEnabled()) {
    throw new Error("LIVE execution refused: LIVE_TRADING_ENABLED=true and TRADING_MODE=LIVE are required");
  }
}

export function assertPaperWorkerNotLive(): void {
  if (isLiveTradingEnabled()) {
    throw new Error(
      "paper worker refuses to run while live flags are on; use npm run dev:live and press Start",
    );
  }
}
