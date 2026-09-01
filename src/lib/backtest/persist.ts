import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db/prisma";
import { childLogger } from "@/lib/logger";
import type { BacktestConfig, BacktestResult } from "@/lib/backtest/types";

const log = childLogger({ component: "backtest-persist" });

export async function persistBacktestResult(
  config: BacktestConfig,
  result: BacktestResult,
): Promise<{ runId: string | null; filePath: string }> {
  const dir = path.join("data", "backtests");
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(dir, `${stamp}-${config.strategy}.json`);
  await writeFile(filePath, JSON.stringify({ config, result }, null, 2), "utf8");

  try {
    const strategy = await prisma.strategy.findUnique({ where: { slug: config.strategy } });
    if (!strategy) {
      log.warn({ slug: config.strategy }, "no Strategy row, skipped Prisma persist");
      return { runId: null, filePath };
    }

    const run = await prisma.backtestRun.create({
      data: {
        strategyId: strategy.id,
        name: config.name,
        parameters: config.parameters,
        trainFrom: config.trainFrom,
        trainTo: config.trainTo,
        validationFrom: config.validationFrom,
        validationTo: config.validationTo,
        testFrom: config.testFrom,
        testTo: config.testTo,
        walkForward: config.walkForward,
        status: "COMPLETED",
        startedAt: new Date(),
        finishedAt: new Date(),
        netPnl: result.metrics.netPnl,
        grossPnl: result.metrics.grossPnl,
        fees: result.metrics.fees,
        maxDrawdown: result.metrics.maxDrawdown,
        winRate: result.metrics.winRate,
        profitFactor:
          result.metrics.profitFactor === Infinity ? null : result.metrics.profitFactor,
        expectancy: result.metrics.expectancy,
        sharpe: result.metrics.sharpe,
        sortino: result.metrics.sortino,
        metrics: result.metrics,
        equityCurve: result.equityCurve,
        trades: {
          create: result.trades.map((trade) => ({
            marketId: trade.marketId,
            openedAt: trade.openedAt,
            closedAt: trade.closedAt,
            side: trade.side,
            direction: trade.direction,
            entryPrice: trade.entryPrice,
            exitPrice: trade.exitPrice,
            size: trade.size,
            grossPnl: trade.grossPnl,
            fees: trade.fees,
            slippage: trade.slippage,
            priceImpact: trade.priceImpact,
            netPnl: trade.netPnl,
            reason: trade.reason,
          })),
        },
      },
    });
    return { runId: run.id, filePath };
  } catch (error) {
    log.warn({ err: String(error) }, "Prisma persist skipped");
    return { runId: null, filePath };
  }
}
