import { TradingMode } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { redis } from "@/lib/db/redis";
import { childLogger } from "@/lib/logger";
import { emptyRiskSnapshot, limitsFromEnv } from "@/lib/risk/limits";
import { persistRiskSnapshot } from "@/lib/risk/persist";
import { PAPER_CYCLE_KEY } from "@/lib/paper/cycle";

const log = childLogger({ component: "dashboard-reset" });

export type ResetScope = "paper" | "record" | "all";

const BATCH = 1_500;

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

async function clearPaperLedger(): Promise<void> {
  const orders = await deleteIdBatches(
    "paper-orders",
    async () => {
      const rows = await prisma.order.findMany({
        where: { mode: TradingMode.PAPER },
        select: { id: true },
        take: BATCH,
      });
      return rows.map((row) => row.id);
    },
    async (ids) => {
      await prisma.fee.deleteMany({ where: { orderId: { in: ids } } });
      await prisma.order.deleteMany({ where: { id: { in: ids } } });
    },
  );

  const positions = await deleteIdBatches(
    "paper-positions",
    async () => {
      const rows = await prisma.position.findMany({
        where: { mode: TradingMode.PAPER },
        select: { id: true },
        take: BATCH,
      });
      return rows.map((row) => row.id);
    },
    async (ids) => {
      await prisma.fee.deleteMany({ where: { positionId: { in: ids } } });
      await prisma.position.deleteMany({ where: { id: { in: ids } } });
    },
  );

  const signals = await deleteIdBatches(
    "signals",
    async () => {
      const rows = await prisma.signal.findMany({ select: { id: true }, take: BATCH });
      return rows.map((row) => row.id);
    },
    async (ids) => {
      await prisma.signal.deleteMany({ where: { id: { in: ids } } });
    },
  );

  await prisma.riskEvent.deleteMany();
  log.info({ orders, positions, signals }, "paper ledger cleared");
}

export async function resetDashboardData(scope: ResetScope): Promise<{
  paper: boolean;
  record: boolean;
}> {
  const paper = scope === "paper" || scope === "all";
  const record = scope === "record" || scope === "all";

  if (paper) {
    await clearPaperLedger();
    await persistRiskSnapshot(emptyRiskSnapshot(limitsFromEnv(), TradingMode.PAPER));
    try {
      await redis.del(PAPER_CYCLE_KEY);
    } catch (error) {
      log.warn({ err: String(error) }, "paper cycle redis clear skipped");
    }
  }

  if (record) {
    await prisma.recordSession.deleteMany();
    log.info("cleared record sessions and ticks");
  }

  return { paper, record };
}
