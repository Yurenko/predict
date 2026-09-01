-- CreateEnum
CREATE TYPE "TradingMode" AS ENUM ('PAPER', 'LIVE');

-- CreateEnum
CREATE TYPE "DataSource" AS ENUM ('WEBSOCKET', 'REST', 'WEBHOOK', 'BACKTEST', 'MANUAL');

-- CreateEnum
CREATE TYPE "OrderSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('MARKET', 'LIMIT');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'SUBMITTED', 'FILLED', 'PARTIALLY_FILLED', 'CANCELLED', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "SignalDirection" AS ENUM ('BUY', 'SELL', 'EXIT', 'FLAT');

-- CreateEnum
CREATE TYPE "PositionStatus" AS ENUM ('OPEN', 'CLOSED', 'PENDING_CLAIM', 'SETTLED');

-- CreateEnum
CREATE TYPE "StrategyKind" AS ENUM ('MEAN_REVERSION', 'UNDERLYING_MOMENTUM_LAG', 'FAIR_VALUE');

-- CreateEnum
CREATE TYPE "RiskEventType" AS ENUM ('MAX_POSITION_SIZE', 'MAX_EXPOSURE', 'MAX_DAILY_LOSS', 'MAX_DRAWDOWN', 'MAX_SLIPPAGE', 'MAX_PRICE_IMPACT', 'MIN_LIQUIDITY', 'MIN_TIME_TO_EXPIRY', 'STALE_DATA', 'API_ERROR', 'ABNORMAL_FILL', 'KILL_SWITCH', 'COOLDOWN');

-- CreateEnum
CREATE TYPE "SystemEventLevel" AS ENUM ('DEBUG', 'INFO', 'WARN', 'ERROR');

-- CreateTable
CREATE TABLE "MarketTopic" (
    "id" TEXT NOT NULL,
    "venue" TEXT NOT NULL DEFAULT 'binance',
    "marketTopicId" TEXT NOT NULL,
    "vendor" TEXT,
    "chainId" TEXT NOT NULL DEFAULT '56',
    "slug" TEXT,
    "title" TEXT NOT NULL,
    "question" TEXT,
    "description" TEXT,
    "imageUrl" TEXT,
    "topicType" TEXT,
    "chartType" TEXT,
    "symbol" TEXT,
    "l1Category" TEXT,
    "l2Category" TEXT,
    "collateral" TEXT,
    "feeRateBps" INTEGER,
    "slippageBps" INTEGER,
    "isYieldBearing" BOOLEAN,
    "tradeVolume" DECIMAL(38,18),
    "liquidity" DECIMAL(38,18),
    "participantCount" INTEGER,
    "status" TEXT,
    "startPrice" DECIMAL(38,18),
    "endPrice" DECIMAL(38,18),
    "priceFeedId" TEXT,
    "priceFeedProvider" TEXT,
    "priceFeedSymbol" TEXT,
    "publishedAt" TIMESTAMP(3),
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "rawPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketTopic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Market" (
    "id" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "venueMarketId" TEXT NOT NULL,
    "externalId" TEXT,
    "title" TEXT NOT NULL,
    "question" TEXT,
    "description" TEXT,
    "conditionId" TEXT,
    "status" TEXT,
    "tradingStatus" TEXT,
    "tradeVolume" DECIMAL(38,18),
    "liquidity" DECIMAL(38,18),
    "decimalPrecision" INTEGER,
    "rawPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Market_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketOutcome" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "outcomeIndex" INTEGER,
    "lastChance" DECIMAL(18,10),
    "lastPrice" DECIMAL(38,18),
    "rawPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketOutcome_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketSnapshot" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "outcomeId" TEXT,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" "DataSource" NOT NULL,
    "lastPrice" DECIMAL(38,18),
    "chance" DECIMAL(18,10),
    "bestBid" DECIMAL(38,18),
    "bestAsk" DECIMAL(38,18),
    "midPrice" DECIMAL(38,18),
    "spread" DECIMAL(38,18),
    "liquidity" DECIMAL(38,18),
    "volume" DECIMAL(38,18),
    "bidDepth" DECIMAL(38,18),
    "askDepth" DECIMAL(38,18),
    "sequence" BIGINT,
    "timeToExpirySec" INTEGER,
    "rawPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UnderlyingSnapshot" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" "DataSource" NOT NULL,
    "price" DECIMAL(38,18) NOT NULL,
    "bid" DECIMAL(38,18),
    "ask" DECIMAL(38,18),
    "volume" DECIMAL(38,18),
    "sequence" BIGINT,
    "rawPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UnderlyingSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PredictionQuote" (
    "id" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "marketId" TEXT,
    "outcomeId" TEXT,
    "tokenId" TEXT NOT NULL,
    "side" "OrderSide" NOT NULL,
    "orderType" "OrderType" NOT NULL,
    "chainId" TEXT,
    "vendor" TEXT,
    "marketTitle" TEXT,
    "marketExtId" TEXT,
    "chance" DECIMAL(18,10),
    "amountIn" DECIMAL(38,18) NOT NULL,
    "amountOut" DECIMAL(38,18) NOT NULL,
    "isMinAmountOut" BOOLEAN,
    "averagePrice" DECIMAL(38,18),
    "lastPrice" DECIMAL(38,18),
    "priceImpact" DECIMAL(38,18),
    "feeAmount" DECIMAL(38,18),
    "feeRateBps" INTEGER,
    "feeDiscountBps" INTEGER,
    "slippageBps" INTEGER,
    "minReceive" DECIMAL(38,18),
    "priceLimit" DECIMAL(38,18),
    "expireAt" TIMESTAMP(3),
    "quotedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rawPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PredictionQuote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RawIngestEvent" (
    "id" TEXT NOT NULL,
    "source" "DataSource" NOT NULL,
    "channel" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payloadHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RawIngestEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Strategy" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "kind" "StrategyKind" NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "parameters" JSONB NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Strategy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Signal" (
    "id" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "outcomeId" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "direction" "SignalDirection" NOT NULL,
    "marketProbability" DECIMAL(18,10) NOT NULL,
    "fairProbability" DECIMAL(18,10),
    "grossEdge" DECIMAL(18,10) NOT NULL,
    "estimatedFees" DECIMAL(38,18) NOT NULL,
    "estimatedSlippage" DECIMAL(38,18) NOT NULL,
    "estimatedPriceImpact" DECIMAL(38,18) NOT NULL,
    "netEdge" DECIMAL(18,10) NOT NULL,
    "confidence" DECIMAL(18,10) NOT NULL,
    "reason" TEXT NOT NULL,
    "riskChecks" JSONB NOT NULL,
    "accepted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Signal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BacktestRun" (
    "id" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parameters" JSONB NOT NULL,
    "trainFrom" TIMESTAMP(3),
    "trainTo" TIMESTAMP(3),
    "validationFrom" TIMESTAMP(3),
    "validationTo" TIMESTAMP(3),
    "testFrom" TIMESTAMP(3) NOT NULL,
    "testTo" TIMESTAMP(3) NOT NULL,
    "walkForward" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "error" TEXT,
    "netPnl" DECIMAL(38,18),
    "grossPnl" DECIMAL(38,18),
    "fees" DECIMAL(38,18),
    "maxDrawdown" DECIMAL(18,10),
    "winRate" DECIMAL(18,10),
    "profitFactor" DECIMAL(18,10),
    "expectancy" DECIMAL(38,18),
    "sharpe" DECIMAL(18,10),
    "sortino" DECIMAL(18,10),
    "metrics" JSONB,
    "equityCurve" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BacktestRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BacktestTrade" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "marketId" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "side" "OrderSide" NOT NULL,
    "direction" "SignalDirection" NOT NULL,
    "entryPrice" DECIMAL(38,18) NOT NULL,
    "exitPrice" DECIMAL(38,18),
    "size" DECIMAL(38,18) NOT NULL,
    "grossPnl" DECIMAL(38,18),
    "fees" DECIMAL(38,18) NOT NULL,
    "slippage" DECIMAL(38,18) NOT NULL,
    "priceImpact" DECIMAL(38,18) NOT NULL,
    "netPnl" DECIMAL(38,18),
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BacktestTrade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Position" (
    "id" TEXT NOT NULL,
    "mode" "TradingMode" NOT NULL DEFAULT 'PAPER',
    "venuePositionId" TEXT,
    "strategyId" TEXT,
    "marketId" TEXT NOT NULL,
    "outcomeId" TEXT,
    "signalId" TEXT,
    "tokenId" TEXT NOT NULL,
    "side" "OrderSide" NOT NULL,
    "status" "PositionStatus" NOT NULL DEFAULT 'OPEN',
    "shares" DECIMAL(38,18) NOT NULL,
    "avgPrice" DECIMAL(38,18) NOT NULL,
    "totalCost" DECIMAL(38,18) NOT NULL,
    "realizedPnl" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "unrealizedPnl" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "feesPaid" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "slippagePaid" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "priceImpactPaid" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "networkCostPaid" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "rawPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Position_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "mode" "TradingMode" NOT NULL DEFAULT 'PAPER',
    "clientOrderId" TEXT NOT NULL,
    "venueOrderId" TEXT,
    "vendorOrderId" TEXT,
    "quoteId" TEXT,
    "positionId" TEXT,
    "signalId" TEXT,
    "marketId" TEXT NOT NULL,
    "outcomeId" TEXT,
    "tokenId" TEXT NOT NULL,
    "side" "OrderSide" NOT NULL,
    "orderType" "OrderType" NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "requestedAmount" DECIMAL(38,18) NOT NULL,
    "priceLimit" DECIMAL(38,18),
    "slippageBps" INTEGER,
    "filledUsdtAmount" DECIMAL(38,18),
    "filledShareQty" DECIMAL(38,18),
    "fillPercentage" DECIMAL(18,10),
    "averagePrice" DECIMAL(38,18),
    "marketProviderFee" DECIMAL(38,18),
    "networkFee" DECIMAL(38,18),
    "idempotencyKey" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "terminalAt" TIMESTAMP(3),
    "rawPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Execution" (
    "id" TEXT NOT NULL,
    "mode" "TradingMode" NOT NULL DEFAULT 'PAPER',
    "orderId" TEXT NOT NULL,
    "positionId" TEXT,
    "executedAt" TIMESTAMP(3) NOT NULL,
    "price" DECIMAL(38,18) NOT NULL,
    "shares" DECIMAL(38,18) NOT NULL,
    "usdtAmount" DECIMAL(38,18) NOT NULL,
    "isPartial" BOOLEAN NOT NULL DEFAULT false,
    "latencyMs" INTEGER,
    "rawPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Execution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Fee" (
    "id" TEXT NOT NULL,
    "orderId" TEXT,
    "positionId" TEXT,
    "kind" TEXT NOT NULL,
    "amount" DECIMAL(38,18) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USDT',
    "bps" INTEGER,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rawPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Fee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskEvent" (
    "id" TEXT NOT NULL,
    "type" "RiskEventType" NOT NULL,
    "severity" "SystemEventLevel" NOT NULL,
    "message" TEXT NOT NULL,
    "marketId" TEXT,
    "strategyId" TEXT,
    "orderId" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RiskEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemEvent" (
    "id" TEXT NOT NULL,
    "level" "SystemEventLevel" NOT NULL,
    "component" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "correlationId" TEXT,
    "strategyId" TEXT,
    "marketId" TEXT,
    "orderId" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "RiskState" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "mode" "TradingMode" NOT NULL DEFAULT 'PAPER',
    "killSwitch" BOOLEAN NOT NULL DEFAULT false,
    "killSwitchReason" TEXT,
    "dailyPnl" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "dailyLossDate" TIMESTAMP(3),
    "peakEquity" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "currentDrawdown" DECIMAL(18,10) NOT NULL DEFAULT 0,
    "consecutiveLosses" INTEGER NOT NULL DEFAULT 0,
    "cooldownUntil" TIMESTAMP(3),
    "staleData" BOOLEAN NOT NULL DEFAULT false,
    "apiErrorBreaker" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RiskState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MarketTopic_marketTopicId_key" ON "MarketTopic"("marketTopicId");

-- CreateIndex
CREATE INDEX "MarketTopic_symbol_status_idx" ON "MarketTopic"("symbol", "status");

-- CreateIndex
CREATE INDEX "MarketTopic_endDate_idx" ON "MarketTopic"("endDate");

-- CreateIndex
CREATE UNIQUE INDEX "Market_venueMarketId_key" ON "Market"("venueMarketId");

-- CreateIndex
CREATE INDEX "Market_topicId_idx" ON "Market"("topicId");

-- CreateIndex
CREATE INDEX "Market_status_tradingStatus_idx" ON "Market"("status", "tradingStatus");

-- CreateIndex
CREATE UNIQUE INDEX "MarketOutcome_tokenId_key" ON "MarketOutcome"("tokenId");

-- CreateIndex
CREATE INDEX "MarketOutcome_marketId_idx" ON "MarketOutcome"("marketId");

-- CreateIndex
CREATE INDEX "MarketSnapshot_marketId_observedAt_idx" ON "MarketSnapshot"("marketId", "observedAt");

-- CreateIndex
CREATE INDEX "MarketSnapshot_outcomeId_observedAt_idx" ON "MarketSnapshot"("outcomeId", "observedAt");

-- CreateIndex
CREATE INDEX "MarketSnapshot_observedAt_idx" ON "MarketSnapshot"("observedAt");

-- CreateIndex
CREATE INDEX "UnderlyingSnapshot_symbol_observedAt_idx" ON "UnderlyingSnapshot"("symbol", "observedAt");

-- CreateIndex
CREATE INDEX "UnderlyingSnapshot_observedAt_idx" ON "UnderlyingSnapshot"("observedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PredictionQuote_quoteId_key" ON "PredictionQuote"("quoteId");

-- CreateIndex
CREATE INDEX "PredictionQuote_tokenId_quotedAt_idx" ON "PredictionQuote"("tokenId", "quotedAt");

-- CreateIndex
CREATE INDEX "PredictionQuote_expireAt_idx" ON "PredictionQuote"("expireAt");

-- CreateIndex
CREATE INDEX "RawIngestEvent_channel_observedAt_idx" ON "RawIngestEvent"("channel", "observedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RawIngestEvent_channel_payloadHash_observedAt_key" ON "RawIngestEvent"("channel", "payloadHash", "observedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Strategy_slug_key" ON "Strategy"("slug");

-- CreateIndex
CREATE INDEX "Signal_strategyId_timestamp_idx" ON "Signal"("strategyId", "timestamp");

-- CreateIndex
CREATE INDEX "Signal_marketId_timestamp_idx" ON "Signal"("marketId", "timestamp");

-- CreateIndex
CREATE INDEX "BacktestRun_strategyId_createdAt_idx" ON "BacktestRun"("strategyId", "createdAt");

-- CreateIndex
CREATE INDEX "BacktestTrade_runId_openedAt_idx" ON "BacktestTrade"("runId", "openedAt");

-- CreateIndex
CREATE INDEX "Position_mode_status_idx" ON "Position"("mode", "status");

-- CreateIndex
CREATE INDEX "Position_marketId_status_idx" ON "Position"("marketId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Position_mode_venuePositionId_key" ON "Position"("mode", "venuePositionId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_clientOrderId_key" ON "Order"("clientOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_idempotencyKey_key" ON "Order"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Order_mode_status_idx" ON "Order"("mode", "status");

-- CreateIndex
CREATE INDEX "Order_venueOrderId_idx" ON "Order"("venueOrderId");

-- CreateIndex
CREATE INDEX "Order_marketId_createdAt_idx" ON "Order"("marketId", "createdAt");

-- CreateIndex
CREATE INDEX "Execution_orderId_executedAt_idx" ON "Execution"("orderId", "executedAt");

-- CreateIndex
CREATE INDEX "Fee_orderId_idx" ON "Fee"("orderId");

-- CreateIndex
CREATE INDEX "Fee_positionId_idx" ON "Fee"("positionId");

-- CreateIndex
CREATE INDEX "RiskEvent_type_createdAt_idx" ON "RiskEvent"("type", "createdAt");

-- CreateIndex
CREATE INDEX "SystemEvent_component_createdAt_idx" ON "SystemEvent"("component", "createdAt");

-- CreateIndex
CREATE INDEX "SystemEvent_correlationId_idx" ON "SystemEvent"("correlationId");

-- AddForeignKey
ALTER TABLE "Market" ADD CONSTRAINT "Market_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "MarketTopic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketOutcome" ADD CONSTRAINT "MarketOutcome_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketSnapshot" ADD CONSTRAINT "MarketSnapshot_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketSnapshot" ADD CONSTRAINT "MarketSnapshot_outcomeId_fkey" FOREIGN KEY ("outcomeId") REFERENCES "MarketOutcome"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PredictionQuote" ADD CONSTRAINT "PredictionQuote_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PredictionQuote" ADD CONSTRAINT "PredictionQuote_outcomeId_fkey" FOREIGN KEY ("outcomeId") REFERENCES "MarketOutcome"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Signal" ADD CONSTRAINT "Signal_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Signal" ADD CONSTRAINT "Signal_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Signal" ADD CONSTRAINT "Signal_outcomeId_fkey" FOREIGN KEY ("outcomeId") REFERENCES "MarketOutcome"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BacktestRun" ADD CONSTRAINT "BacktestRun_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BacktestTrade" ADD CONSTRAINT "BacktestTrade_runId_fkey" FOREIGN KEY ("runId") REFERENCES "BacktestRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BacktestTrade" ADD CONSTRAINT "BacktestTrade_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_outcomeId_fkey" FOREIGN KEY ("outcomeId") REFERENCES "MarketOutcome"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "Signal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "PredictionQuote"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "Position"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "Signal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_outcomeId_fkey" FOREIGN KEY ("outcomeId") REFERENCES "MarketOutcome"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Execution" ADD CONSTRAINT "Execution_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Execution" ADD CONSTRAINT "Execution_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "Position"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fee" ADD CONSTRAINT "Fee_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fee" ADD CONSTRAINT "Fee_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "Position"("id") ON DELETE SET NULL ON UPDATE CASCADE;

