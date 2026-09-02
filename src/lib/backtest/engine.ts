import { TradingMode } from "@prisma/client";
import type { OrderSide, Strategy, StrategySignal } from "@/lib/types/domain";
import type {
  BacktestConfig,
  BacktestFoldResult,
  BacktestResult,
  BacktestTradeResult,
  HistoricalQuote,
  MarketTick,
  ReplayEvent,
  UnderlyingTick,
} from "@/lib/backtest/types";
import { buildStrategyContext, quoteAsOf } from "@/lib/backtest/context";
import { appendTick, lastAtOrBefore } from "@/lib/backtest/features";
import { simulateFill } from "@/lib/backtest/fills";
import { computeMetrics, equityCurveFromTrades } from "@/lib/backtest/metrics";
import { historyStart, walkForwardWindows } from "@/lib/backtest/windows";
import { evaluateRisk } from "@/lib/risk/evaluate";
import { emptyRiskSnapshot } from "@/lib/risk/limits";
import { recordClosedTrade } from "@/lib/risk/state";
import type { RiskLimits } from "@/lib/risk/types";
import { isExpiredAt, settlementPayoff } from "@/lib/markets/settlement";

interface OpenPosition {
  marketId: string;
  outcomeId?: string;
  side: OrderSide;
  openedAt: Date;
  entryPrice: number;
  size: number;
  fees: number;
  slippage: number;
  priceImpact: number;
  networkCost: number;
}

export function sortReplayEvents(events: ReplayEvent[]): ReplayEvent[] {
  return [...events].sort((a, b) => {
    const delta = a.at.getTime() - b.at.getTime();
    if (delta !== 0) return delta;
    if (a.kind === b.kind) return 0;
    return a.kind === "underlying" ? -1 : 1;
  });
}

function isExpired(tick: MarketTick, now: Date): boolean {
  return isExpiredAt(now, tick.endDate, tick.timeToExpirySec);
}

function riskLimitsForBacktest(config: BacktestConfig): RiskLimits {
  return {
    bankrollUsdt: config.bankrollUsdt,
    maxPositionPct: config.maxPositionPct,
    maxSimultaneousPositions: config.maxSimultaneousPositions,
    maxDailyLossPct: 100,
    maxDrawdownPct: 100,
    maxSlippageBps: 100_000,
    maxPriceImpact: config.maxPriceImpact,
    minLiquidityUsdt: config.minLiquidityUsdt,
    minTimeToExpirySec: config.minTimeToExpirySec,
    maxTimeToExpirySec: 10 * 365 * 86_400,
    staleMs: 86_400_000,
    cooldownMs: 0,
    consecutiveLossesForCooldown: 1_000_000,
    liveTradingEnabled: false,
  };
}

export function runBacktestFold(options: {
  events: ReplayEvent[];
  quotes?: HistoricalQuote[];
  strategy: Strategy;
  config: BacktestConfig;
  testFrom: Date;
  testTo: Date;
  historyFrom: Date;
}): BacktestFoldResult {
  const quotes = options.quotes ?? [];
  const events = sortReplayEvents(options.events).filter(
    (event) =>
      event.at.getTime() >= options.historyFrom.getTime() &&
      event.at.getTime() <= options.testTo.getTime(),
  );

  const underlyings = new Map<string, UnderlyingTick[]>();
  const markets = new Map<string, MarketTick[]>();
  const probabilities = new Map<string, Array<{ observedAt: Date; value: number }>>();
  const latestMarket = new Map<string, MarketTick>();
  const open = new Map<string, OpenPosition>();
  const riskLimits = riskLimitsForBacktest(options.config);
  let riskState = emptyRiskSnapshot(riskLimits);
  const trades: BacktestTradeResult[] = [];
  const skipped: BacktestFoldResult["skipped"] = [];
  const signals: StrategySignal[] = [];
  let lastClock = 0;

  const inTest = (at: Date) =>
    at.getTime() >= options.testFrom.getTime() && at.getTime() <= options.testTo.getTime();

  const close = (
    position: OpenPosition,
    tick: MarketTick,
    now: Date,
    reason: string,
    underlyingsForSymbol: UnderlyingTick[],
  ) => {
    const expired = isExpired(tick, now);
    const asOf = tick.endDate && expired ? tick.endDate : now;
    const underlying = tick.symbol ? lastAtOrBefore(underlyingsForSymbol, asOf) : null;
    const payoff = expired ? settlementPayoff(tick, underlying?.price ?? null) : null;

    let exitPrice: number | null = payoff;
    let exitCosts = { fee: 0, slippage: 0, priceImpact: 0, networkCost: 0 };

    if (exitPrice === null) {
      const top = position.side === "BUY" ? tick.bestBid : tick.bestAsk;
      const requestedNotional = position.size * (top ?? position.entryPrice);
      const fill = simulateFill({
        side: position.side === "BUY" ? "SELL" : "BUY",
        requestedNotional,
        bestBid: tick.bestBid,
        bestAsk: tick.bestAsk,
        lastPrice: tick.lastPrice,
        bidDepth: tick.bidDepth,
        askDepth: tick.askDepth,
        liquidity: tick.liquidity,
        quote: quoteAsOf(quotes, tick.tokenId, now),
        costs: options.config.costs,
        maxPriceImpact: options.config.maxPriceImpact,
      });
      if (!fill.ok) {
        const fallback = position.side === "BUY" ? tick.bestBid : tick.bestAsk;
        if (fallback === null) {
          skipped.push({ at: now, marketId: tick.marketId, reason: `exit_${fill.reason}` });
          return;
        }
        exitPrice = fallback;
      } else {
        exitPrice = fill.price;
        exitCosts = {
          fee: fill.fee,
          slippage: fill.slippage,
          priceImpact: fill.priceImpact,
          networkCost: fill.networkCost,
        };
      }
    }

    const grossPnl =
      position.side === "BUY"
        ? (exitPrice - position.entryPrice) * position.size
        : (position.entryPrice - exitPrice) * position.size;
    const fees = position.fees + position.networkCost + exitCosts.fee + exitCosts.networkCost;
    const slippage = position.slippage + exitCosts.slippage;
    const priceImpact = position.priceImpact + exitCosts.priceImpact;
    const netPnl = grossPnl - fees - slippage - priceImpact;

    trades.push({
      marketId: position.marketId,
      openedAt: position.openedAt,
      closedAt: now,
      side: position.side,
      direction: "EXIT",
      entryPrice: position.entryPrice,
      exitPrice,
      size: position.size,
      grossPnl,
      fees,
      slippage,
      priceImpact,
      netPnl,
      reason,
    });
    open.delete(position.marketId);
    riskState = recordClosedTrade(riskState, netPnl, now, riskLimits).state;
  };

  const maybeOpen = (tick: MarketTick, now: Date, signal: StrategySignal) => {
    if (!inTest(now)) return;
    if (open.has(tick.marketId)) return;

    const side: OrderSide = signal.direction === "SELL" ? "SELL" : "BUY";
    const notional = options.config.bankrollUsdt * (options.config.maxPositionPct / 100);
    const openNotional = [...open.values()].reduce(
      (sum, pos) => sum + pos.size * pos.entryPrice,
      0,
    );
    const decision = evaluateRisk(
      {
        action: "ENTER",
        mode: TradingMode.PAPER,
        now,
        strategyId: signal.strategyId,
        marketId: tick.marketId,
        requestedNotional: notional,
        bestBid: tick.bestBid,
        bestAsk: tick.bestAsk,
        lastPrice: tick.lastPrice,
        liquidity: tick.liquidity,
        timeToExpirySec: tick.timeToExpirySec,
        estimatedSlippageBps: null,
        estimatedPriceImpact:
          tick.liquidity && tick.liquidity > 0 ? notional / tick.liquidity : 0,
        quoteExpireAt: null,
        dataAgeMs: 0,
      },
      {
        ...riskState,
        openPositions: open.size,
        openNotional,
      },
      riskLimits,
    );
    if (!decision.allowed) {
      const failed = decision.checks.find((item) => !item.passed);
      skipped.push({ at: now, marketId: tick.marketId, reason: failed?.name ?? "risk" });
      return;
    }

    const fill = simulateFill({
      side,
      requestedNotional: notional,
      bestBid: tick.bestBid,
      bestAsk: tick.bestAsk,
      lastPrice: tick.lastPrice,
      bidDepth: tick.bidDepth,
      askDepth: tick.askDepth,
      liquidity: tick.liquidity,
      quote: quoteAsOf(quotes, tick.tokenId, now),
      costs: options.config.costs,
      maxPriceImpact: options.config.maxPriceImpact,
    });
    if (!fill.ok) {
      skipped.push({ at: now, marketId: tick.marketId, reason: fill.reason });
      return;
    }

    open.set(tick.marketId, {
      marketId: tick.marketId,
      outcomeId: tick.outcomeId ?? undefined,
      side,
      openedAt: now,
      entryPrice: fill.price,
      size: fill.shares,
      fees: fill.fee,
      slippage: fill.slippage,
      priceImpact: fill.priceImpact,
      networkCost: fill.networkCost,
    });
  };

  const evaluateMarket = (tick: MarketTick, now: Date) => {
    const symbolTicks = tick.symbol ? (underlyings.get(tick.symbol) ?? []) : [];
    const position = open.get(tick.marketId);

    if (position && isExpired(tick, now)) {
      close(position, tick, now, "expired", symbolTicks);
      return;
    }

    const ctx = buildStrategyContext({
      now,
      tick,
      underlyings: symbolTicks,
      probability: probabilities.get(tick.marketId) ?? [],
      quotes,
      rollingWindow: options.config.rollingWindow,
    });
    const signal = options.strategy.evaluate(ctx);
    if (!signal) return;
    signals.push(signal);

    if (signal.direction === "FLAT" || signal.direction === "EXIT") {
      if (position) close(position, tick, now, signal.reason || "signal_exit", symbolTicks);
      return;
    }

    if (position) {
      const signalSide: OrderSide = signal.direction === "SELL" ? "SELL" : "BUY";
      if (signalSide !== position.side) {
        close(position, tick, now, signal.reason || "reverse_exit", symbolTicks);
      }
      return;
    }

    maybeOpen(tick, now, signal);
  };

  for (const event of events) {
    if (event.at.getTime() < lastClock) {
      throw new Error("look-ahead blocked: replay went backwards");
    }
    lastClock = event.at.getTime();
    const now = event.at;

    if (event.kind === "underlying") {
      const list = underlyings.get(event.tick.symbol) ?? [];
      appendTick(list, event.tick);
      underlyings.set(event.tick.symbol, list);
      for (const tick of latestMarket.values()) {
        if (tick.symbol === event.tick.symbol) {
          evaluateMarket(tick, now);
        }
      }
      continue;
    }

    const list = markets.get(event.tick.marketId) ?? [];
    appendTick(list, event.tick);
    markets.set(event.tick.marketId, list);
    latestMarket.set(event.tick.marketId, event.tick);
    const probability = event.tick.chance ?? event.tick.midPrice;
    if (probability !== null) {
      const series = probabilities.get(event.tick.marketId) ?? [];
      appendTick(series, { observedAt: event.tick.observedAt, value: probability });
      probabilities.set(event.tick.marketId, series);
    }
    evaluateMarket(event.tick, now);
  }

  const end = options.testTo;
  for (const position of [...open.values()]) {
    const tick = latestMarket.get(position.marketId);
    if (!tick) continue;
    const symbolTicks = tick.symbol ? (underlyings.get(tick.symbol) ?? []) : [];
    close(position, tick, end, "end_of_window", symbolTicks);
  }

  const equityCurve = equityCurveFromTrades(options.config.bankrollUsdt, trades);
  return {
    trainFrom: null,
    trainTo: null,
    testFrom: options.testFrom,
    testTo: options.testTo,
    trades,
    equityCurve,
    metrics: computeMetrics(trades, equityCurve, skipped.length),
    skipped,
    signals,
  };
}

export function runBacktest(options: {
  events: ReplayEvent[];
  quotes?: HistoricalQuote[];
  strategy: Strategy;
  config: BacktestConfig;
}): BacktestResult {
  const folds: BacktestFoldResult[] = [];

  if (options.config.walkForward) {
    const windows = walkForwardWindows({
      from: options.config.testFrom,
      to: options.config.testTo,
      trainDays: options.config.walkForwardTrainDays,
      testDays: options.config.walkForwardTestDays,
      stepDays: options.config.walkForwardStepDays,
    });
    for (const window of windows) {
      const fold = runBacktestFold({
        ...options,
        testFrom: window.testFrom,
        testTo: window.testTo,
        historyFrom: window.trainFrom,
      });
      fold.trainFrom = window.trainFrom;
      fold.trainTo = window.trainTo;
      folds.push(fold);
    }
  } else {
    folds.push(
      runBacktestFold({
        ...options,
        testFrom: options.config.testFrom,
        testTo: options.config.testTo,
        historyFrom: historyStart({
          trainFrom: options.config.trainFrom,
          testFrom: options.config.testFrom,
          lookbackMinutes: options.config.lookbackMinutes,
        }),
      }),
    );
  }

  const trades = folds.flatMap((fold) => fold.trades);
  const equityCurve = equityCurveFromTrades(options.config.bankrollUsdt, trades);
  const skipped = folds.reduce((sum, fold) => sum + fold.skipped.length, 0);

  return {
    name: options.config.name,
    strategy: options.config.strategy,
    walkForward: options.config.walkForward,
    folds,
    trades,
    equityCurve,
    metrics: computeMetrics(trades, equityCurve, skipped),
  };
}
