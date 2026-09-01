import { readFile } from "node:fs/promises";
import { z } from "zod";
import { env } from "@/lib/config/env";
import type { BacktestConfig } from "@/lib/backtest/types";

const dateSchema = z
  .string()
  .transform((value, ctx) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      ctx.addIssue({ code: "custom", message: "Invalid datetime" });
      return z.NEVER;
    }
    return date;
  });

const optionalDate = dateSchema.optional().nullable();

const fileSchema = z.object({
  name: z.string().min(1),
  strategy: z.string().min(1),
  trainFrom: optionalDate,
  trainTo: optionalDate,
  validationFrom: optionalDate,
  validationTo: optionalDate,
  testFrom: dateSchema,
  testTo: dateSchema,
  walkForward: z.boolean().default(false),
  walkForwardTrainDays: z.number().int().positive().default(14),
  walkForwardTestDays: z.number().int().positive().default(7),
  walkForwardStepDays: z.number().int().positive().default(7),
  lookbackMinutes: z.number().int().positive().optional(),
  rollingWindow: z.number().int().positive().optional(),
  parameters: z.record(z.string(), z.unknown()).default({}),
  costs: z
    .object({
      useQuoteFees: z.boolean().default(true),
      fallbackFeeRateBps: z.number().int().nonnegative().nullable().default(null),
      simulateSlippage: z.boolean().default(true),
      simulatePriceImpact: z.boolean().default(true),
      allowPartialFills: z.boolean().default(true),
      networkCostUsdt: z.number().nonnegative().default(0),
    })
    .default({
      useQuoteFees: true,
      fallbackFeeRateBps: null,
      simulateSlippage: true,
      simulatePriceImpact: true,
      allowPartialFills: true,
      networkCostUsdt: 0,
    }),
  bankrollUsdt: z.number().positive().optional(),
  maxPositionPct: z.number().positive().optional(),
  maxSimultaneousPositions: z.number().int().positive().optional(),
  minTimeToExpirySec: z.number().int().nonnegative().optional(),
  minLiquidityUsdt: z.number().nonnegative().optional(),
  maxPriceImpact: z.number().nonnegative().optional(),
  safetyMargin: z.number().nonnegative().optional(),
});

export function parseBacktestConfig(raw: unknown): BacktestConfig {
  const parsed = fileSchema.parse(raw);
  const lookbackMinutes =
    parsed.lookbackMinutes ??
    (typeof parsed.parameters.lookbackMinutes === "number"
      ? parsed.parameters.lookbackMinutes
      : 15);
  const rollingWindow =
    parsed.rollingWindow ??
    (typeof parsed.parameters.rollingWindow === "number"
      ? parsed.parameters.rollingWindow
      : 60);

  if (parsed.testTo.getTime() <= parsed.testFrom.getTime()) {
    throw new Error("backtest testTo must be after testFrom");
  }

  return {
    name: parsed.name,
    strategy: parsed.strategy,
    trainFrom: parsed.trainFrom ?? null,
    trainTo: parsed.trainTo ?? null,
    validationFrom: parsed.validationFrom ?? null,
    validationTo: parsed.validationTo ?? null,
    testFrom: parsed.testFrom,
    testTo: parsed.testTo,
    walkForward: parsed.walkForward,
    walkForwardTrainDays: parsed.walkForwardTrainDays,
    walkForwardTestDays: parsed.walkForwardTestDays,
    walkForwardStepDays: parsed.walkForwardStepDays,
    lookbackMinutes,
    rollingWindow,
    parameters: parsed.parameters,
    costs: parsed.costs,
    bankrollUsdt: parsed.bankrollUsdt ?? env.BANKROLL_USDT,
    maxPositionPct: parsed.maxPositionPct ?? env.MAX_POSITION_PCT,
    maxSimultaneousPositions:
      parsed.maxSimultaneousPositions ?? env.MAX_SIMULTANEOUS_POSITIONS,
    minTimeToExpirySec: parsed.minTimeToExpirySec ?? env.MIN_TIME_TO_EXPIRY_SEC,
    minLiquidityUsdt: parsed.minLiquidityUsdt ?? env.MIN_LIQUIDITY_USDT,
    maxPriceImpact: parsed.maxPriceImpact ?? env.MAX_PRICE_IMPACT,
    safetyMargin: parsed.safetyMargin ?? env.SAFETY_MARGIN,
  };
}

export async function loadBacktestConfigFile(path: string): Promise<BacktestConfig> {
  const text = await readFile(path, "utf8");
  return parseBacktestConfig(JSON.parse(text));
}
