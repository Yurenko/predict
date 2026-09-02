-- CreateTable
CREATE TABLE "RecordSession" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stoppedAt" TIMESTAMP(3),
    "tickCount" INTEGER NOT NULL DEFAULT 0,
    "signalCount" INTEGER NOT NULL DEFAULT 0,
    "marketCount" INTEGER NOT NULL DEFAULT 0,
    "lastSampleAt" TIMESTAMP(3),
    "workerPid" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecordSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecordTick" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "marketId" TEXT NOT NULL,
    "marketTitle" TEXT NOT NULL,
    "venueMarketId" TEXT NOT NULL,
    "symbol" TEXT,
    "bestBid" DECIMAL(38,18),
    "bestAsk" DECIMAL(38,18),
    "chance" DECIMAL(18,10),
    "lastPrice" DECIMAL(38,18),
    "liquidity" DECIMAL(38,18),
    "spread" DECIMAL(38,18),
    "timeToExpirySec" INTEGER,
    "liveBook" BOOLEAN NOT NULL DEFAULT false,
    "underlyingPrice" DECIMAL(38,18),
    "underlyingReturn1m" DECIMAL(18,10),
    "underlyingReturn5m" DECIMAL(18,10),
    "underlyingReturn15m" DECIMAL(18,10),
    "probabilityMean" DECIMAL(18,10),
    "probabilityStd" DECIMAL(18,10),
    "probabilityZ" DECIMAL(18,10),
    "signals" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecordTick_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecordSession_status_startedAt_idx" ON "RecordSession"("status", "startedAt");

-- CreateIndex
CREATE INDEX "RecordTick_sessionId_observedAt_idx" ON "RecordTick"("sessionId", "observedAt");

-- CreateIndex
CREATE INDEX "RecordTick_marketId_observedAt_idx" ON "RecordTick"("marketId", "observedAt");

-- AddForeignKey
ALTER TABLE "RecordTick" ADD CONSTRAINT "RecordTick_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "RecordSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
