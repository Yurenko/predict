import { TradingMode } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { redis } from "@/lib/db/redis";
import { childLogger } from "@/lib/logger";
import { isLiveTradingEnabled } from "@/lib/config/env";
import { emptyRiskSnapshot, limitsFromEnv } from "@/lib/risk/limits";
import { persistRiskSnapshot } from "@/lib/risk/persist";
import { PAPER_CYCLE_KEY } from "@/lib/paper/cycle";
import { resetPaperIdempotencyCache } from "@/lib/paper/engine";
import { resetLiveIdempotencyCache } from "@/lib/live/engine";
import { clearAllPendingFlips } from "@/lib/live/pending-flip";
import { readRecordControl, writeRecordControl } from "@/lib/record/control";
import { isPidAlive } from "@/lib/record/types";

const log = childLogger({ component: "dashboard-reset" });

export type ResetScope = "paper" | "record" | "all";

const BATCH = 1_500;

export function riskModeAfterLedgerReset(liveTradingEnabled: boolean): TradingMode {
  return liveTradingEnabled ? TradingMode.LIVE : TradingMode.PAPER;
}

async function deleteIdBatches(
  label: string,
  fetchBatch: () => Promise<string[]>,
  wipe: (ids: string[]) => Promise<unknown>,
): Promise<number> {
  let total = 0;
  for (;;) {
    const ids = await fetchBatch();
    if (ids.length === 0) return total;
    await wipe(ids);
    total += ids.length;
    log.info({ label, batch: ids.length, total }, "reset batch");
  }
}

function idsOf(rows: Array<{ id: string }>): string[] {
  return rows.map((row) => row.id);
}

/** Wipe paper and LIVE orders/positions/signals. Does not cancel Binance fills. */
async function clearTradingLedger(): Promise<void> {
  const executions = await deleteIdBatches(
    "executions",
    async () => idsOf(await prisma.execution.findMany({ select: { id: true }, take: BATCH })),
    async (ids) => {
      await prisma.execution.deleteMany({ where: { id: { in: ids } } });
    },
  );

  const fees = await deleteIdBatches(
    "fees",
    async () => idsOf(await prisma.fee.findMany({ select: { id: true }, take: BATCH })),
    async (ids) => {
      await prisma.fee.deleteMany({ where: { id: { in: ids } } });
    },
  );

  const orders = await deleteIdBatches(
    "orders",
    async () => idsOf(await prisma.order.findMany({ select: { id: true }, take: BATCH })),
    async (ids) => {
      await prisma.order.deleteMany({ where: { id: { in: ids } } });
    },
  );

  const positions = await deleteIdBatches(
    "positions",
    async () => idsOf(await prisma.position.findMany({ select: { id: true }, take: BATCH })),
    async (ids) => {
      await prisma.position.deleteMany({ where: { id: { in: ids } } });
    },
  );

  const signals = await deleteIdBatches(
    "signals",
    async () => idsOf(await prisma.signal.findMany({ select: { id: true }, take: BATCH })),
    async (ids) => {
      await prisma.signal.deleteMany({ where: { id: { in: ids } } });
    },
  );

  await prisma.riskEvent.deleteMany();
  log.info({ executions, fees, orders, positions, signals }, "trading ledger cleared");
}

async function clearRecordTape(): Promise<void> {
  const ticks = await deleteIdBatches(
    "record-ticks",
    async () => idsOf(await prisma.recordTick.findMany({ select: { id: true }, take: BATCH })),
    async (ids) => {
      await prisma.recordTick.deleteMany({ where: { id: { in: ids } } });
    },
  );
  const sessions = await prisma.recordSession.deleteMany();
  await writeRecordControl({
    sessionId: null,
    lastSampleAt: null,
    lastError: null,
    paper: null,
  });
  log.info({ ticks, sessions: sessions.count }, "cleared record sessions and ticks");
}

export async function resetDashboardData(scope: ResetScope): Promise<{
  paper: boolean;
  record: boolean;
}> {
  const paper = scope === "paper" || scope === "all";
  const record = scope === "record" || scope === "all";

  const control = await readRecordControl();
  if (control.desired === "running" && isPidAlive(control.pid)) {
    throw new Error("stop_first");
  }

  if (paper) {
    await clearTradingLedger();
    await persistRiskSnapshot(
      emptyRiskSnapshot(limitsFromEnv(), riskModeAfterLedgerReset(isLiveTradingEnabled())),
    );
    resetPaperIdempotencyCache();
    resetLiveIdempotencyCache();
    try {
      await redis.del(PAPER_CYCLE_KEY);
    } catch (error) {
      log.warn({ err: String(error) }, "paper cycle redis clear skipped");
    }
    try {
      const pending = await clearAllPendingFlips();
      if (pending > 0) log.info({ pending }, "pending flips cleared");
    } catch (error) {
      log.warn({ err: String(error) }, "pending flip redis clear skipped");
    }
    try {
      await writeRecordControl({ paper: null });
    } catch (error) {
      log.warn({ err: String(error) }, "record cycle snapshot clear skipped");
    }
  }

  if (record) {
    await clearRecordTape();
  }

  return { paper, record };
}
