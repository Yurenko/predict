import { prisma } from "@/lib/db/prisma";
import { childLogger } from "@/lib/logger";
import { asNumber } from "@/lib/normalize/numbers";
import type { RiskDecision, RiskSnapshot } from "@/lib/risk/types";
import { emptyRiskSnapshot, limitsFromEnv } from "@/lib/risk/limits";
import { Prisma } from "@prisma/client";

const log = childLogger({ component: "risk-persist" });

export async function loadRiskState(): Promise<RiskSnapshot> {
  const limits = limitsFromEnv();
  try {
    const [row, open] = await Promise.all([
      prisma.riskState.findUnique({ where: { id: "global" } }),
      prisma.position.findMany({
        where: { status: "OPEN" },
        select: { shares: true, avgPrice: true },
      }),
    ]);
    const openNotional = open.reduce(
      (sum, pos) => sum + (asNumber(pos.shares) ?? 0) * (asNumber(pos.avgPrice) ?? 0),
      0,
    );
    if (!row) {
      return { ...emptyRiskSnapshot(limits), openPositions: open.length, openNotional };
    }
    const peak = asNumber(row.peakEquity) || limits.bankrollUsdt;
    const dd = asNumber(row.currentDrawdown) ?? 0;
    return {
      mode: row.mode,
      killSwitch: row.killSwitch,
      killSwitchReason: row.killSwitchReason,
      dailyPnl: asNumber(row.dailyPnl) ?? 0,
      dailyLossDate: row.dailyLossDate ? row.dailyLossDate.toISOString().slice(0, 10) : null,
      peakEquity: peak,
      equity: peak * (1 - dd),
      currentDrawdown: dd,
      consecutiveLosses: row.consecutiveLosses,
      cooldownUntil: row.cooldownUntil,
      staleData: row.staleData,
      apiErrorBreaker: row.apiErrorBreaker,
      openPositions: open.length,
      openNotional,
    };
  } catch (error) {
    log.warn({ err: String(error) }, "loadRiskState skipped");
    return emptyRiskSnapshot(limits);
  }
}

export async function persistRiskSnapshot(state: RiskSnapshot): Promise<void> {
  try {
    await prisma.riskState.upsert({
      where: { id: "global" },
      create: {
        id: "global",
        mode: state.mode,
        killSwitch: state.killSwitch,
        killSwitchReason: state.killSwitchReason,
        dailyPnl: state.dailyPnl,
        dailyLossDate: state.dailyLossDate ? new Date(`${state.dailyLossDate}T00:00:00.000Z`) : null,
        peakEquity: state.peakEquity,
        currentDrawdown: state.currentDrawdown,
        consecutiveLosses: state.consecutiveLosses,
        cooldownUntil: state.cooldownUntil,
        staleData: state.staleData,
        apiErrorBreaker: state.apiErrorBreaker,
      },
      update: {
        mode: state.mode,
        killSwitch: state.killSwitch,
        killSwitchReason: state.killSwitchReason,
        dailyPnl: state.dailyPnl,
        dailyLossDate: state.dailyLossDate ? new Date(`${state.dailyLossDate}T00:00:00.000Z`) : null,
        peakEquity: state.peakEquity,
        currentDrawdown: state.currentDrawdown,
        consecutiveLosses: state.consecutiveLosses,
        cooldownUntil: state.cooldownUntil,
        staleData: state.staleData,
        apiErrorBreaker: state.apiErrorBreaker,
      },
    });
  } catch (error) {
    log.warn({ err: String(error) }, "persistRiskSnapshot skipped");
  }
}

export async function persistRiskDecision(
  decision: RiskDecision,
  extra?: { marketId?: string; strategyId?: string },
): Promise<void> {
  try {
    await persistRiskSnapshot(decision.nextState);

    if (decision.events.length === 0) return;
    await prisma.riskEvent.createMany({
      data: decision.events.map((item) => ({
        type: item.type,
        severity: item.severity,
        message: item.message,
        marketId: extra?.marketId ?? null,
        strategyId: extra?.strategyId ?? null,
        details: { checks: decision.checks, allowed: decision.allowed } as unknown as Prisma.InputJsonValue,
      })),
    });
  } catch (error) {
    log.warn({ err: String(error) }, "persistRiskDecision skipped");
  }
}
