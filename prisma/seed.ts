import { PrismaClient, StrategyKind } from "@prisma/client";

const prisma = new PrismaClient();

const strategies = [
  {
    slug: "underlying-momentum-lag",
    kind: StrategyKind.UNDERLYING_MOMENTUM_LAG,
    name: "Underlying Momentum → Prediction Lag",
    version: "0.1.0",
    enabled: false,
    description:
      "Trade when the underlying has already moved and the prediction market has not fully repriced. Research priority #1.",
    parameters: {
      returns: ["1m", "5m", "15m"],
      minNetEdge: 0.02,
      minTimeToExpirySec: 60,
      lookbackMinutes: 15,
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
