import { PrismaClient, StrategyKind } from "@prisma/client";

const prisma = new PrismaClient();

const strategies = [
  {
    slug: "underlying-momentum-lag",
    kind: StrategyKind.UNDERLYING_MOMENTUM_LAG,
    name: "Underlying vs window start (5m/15m candle)",
    version: "0.5.0",
    enabled: false,
    description:
      "5m/15m Up/Down: if BTC/ETH is below this window's startPrice → Down; above → Up. Recent tape can flip that candle: 1m on 5m markets, 5m on 15m markets. Last 2 minutes follow the candle, not the tape. Does not mix 15m lookback into a 5m contract.",
    parameters: {
      minVsStart: 0.0005,
      minReturn1m: 0.0003,
      minReturn5m: 0.00067,
      maxBuyAsk: 0.75,
      minSellBid: 0.25,
      minTimeToExpirySec: 60,
      ignoreReversal1mWithinSec: 120,
    },
  },
  {
    slug: "mean-reversion",
    kind: StrategyKind.MEAN_REVERSION,
    name: "Mean Reversion / Probability Spread",
    version: "0.1.0",
    enabled: false,
    description:
      "Z-score of probability vs rolling mean/volatility. Do not use a raw spread > X rule.",
    parameters: {
      rollingWindow: 60,
      entryZ: 2,
      exitZ: 0.5,
      minNetEdge: 0.015,
      minTimeToExpirySec: 60,
    },
  },
  {
    slug: "fair-value",
    kind: StrategyKind.FAIR_VALUE,
    name: "Fair Value / Probability Model",
    version: "0.1.0",
    enabled: false,
    description:
      "Compare model probability to executable market probability after all costs plus safety margin.",
    parameters: {
      minNetEdge: 0.02,
      safetyMargin: 0.005,
      minTimeToExpirySec: 60,
    },
  },
];

async function main() {
  for (const strategy of strategies) {
    await prisma.strategy.upsert({
      where: { slug: strategy.slug },
      update: {
        name: strategy.name,
        version: strategy.version,
        description: strategy.description,
        parameters: strategy.parameters,
      },
      create: strategy,
    });
  }

  await prisma.systemSetting.upsert({
    where: { key: "trading" },
    update: {},
    create: {
      key: "trading",
      value: {
        mode: "PAPER",
        liveTradingEnabled: false,
      },
    },
  });

  await prisma.riskState.upsert({
    where: { id: "global" },
    update: {},
    create: {
      id: "global",
      mode: "PAPER",
      killSwitch: false,
    },
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
