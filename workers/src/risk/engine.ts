import { evaluateRisk } from "@/lib/risk/evaluate";
import { limitsFromEnv } from "@/lib/risk/limits";
import { loadRiskState } from "@/lib/risk/persist";
import { isLiveTradingEnabled } from "@/lib/config/env";
import { childLogger } from "@/lib/logger";

const log = childLogger({ component: "risk-worker" });

export async function reportRisk(): Promise<void> {
  const limits = limitsFromEnv();
  const state = await loadRiskState();
  log.info(
    {
      liveTradingEnabled: isLiveTradingEnabled(),
      limits,
      state: {
        killSwitch: state.killSwitch,
        killSwitchReason: state.killSwitchReason,
        dailyPnl: state.dailyPnl,
        currentDrawdown: state.currentDrawdown,
        staleData: state.staleData,
        apiErrorBreaker: state.apiErrorBreaker,
        cooldownUntil: state.cooldownUntil,
        openPositions: state.openPositions,
        mode: state.mode,
      },
    },
    "risk gates: ENTER blocked on kill/stale/api/limits; EXIT still allowed to flatten",
  );

  const sample = evaluateRisk(
    {
      action: "ENTER",
      mode: state.mode,
      now: new Date(),
      marketId: "status",
      requestedNotional: limits.bankrollUsdt * (limits.maxPositionPct / 100),
      bestBid: 0.49,
      bestAsk: 0.51,
      lastPrice: null,
      liquidity: limits.minLiquidityUsdt,
      timeToExpirySec: limits.minTimeToExpirySec,
      estimatedSlippageBps: 0,
      estimatedPriceImpact: 0,
      quoteExpireAt: null,
      dataAgeMs: 0,
    },
    state,
    limits,
  );
  log.info(
    { allowed: sample.allowed, failed: sample.checks.filter((item) => !item.passed) },
    "sample ENTER decision against current state",
  );
}
