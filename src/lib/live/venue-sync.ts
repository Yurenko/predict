import { PositionStatus, Prisma, TradingMode } from "@prisma/client";
import type { W3WPredictionRestAPI } from "@binance/w3w-prediction";
import { prisma } from "@/lib/db/prisma";
import { childLogger } from "@/lib/logger";
import { isExpiredAt } from "@/lib/markets/settlement";
import type { LiveTradeContext } from "@/lib/live/engine";
import {
  LIVE_CLAIM_DELAY_MS,
  VENUE_POSITION_TABS,
  isClaimFinished,
  isClaimInFlight,
  mapVenuePosition,
  mergeClaimState,
  mergeVenuePosition,
  parseClaimState,
  pickClaimTokenIds,
  pickSingleClaimToken,
  shouldClaimPosition,
  settledRealizedPnl,
  stampClaimEligibleAt,
  type VenuePositionNumbers,
} from "@/lib/live/claim";
import { clearLiveFlatten } from "@/lib/live/flatten";
import { asNumber } from "@/lib/normalize/numbers";
import { limitsFromEnv } from "@/lib/risk/limits";
import { loadRiskState, persistRiskSnapshot } from "@/lib/risk/persist";
import { recordClosedTrade } from "@/lib/risk/state";

const log = childLogger({ component: "live-venue-sync" });

export interface LivePositionVenue {
  queryPositions(
    params: W3WPredictionRestAPI.QueryPositionsRequest,
  ): Promise<W3WPredictionRestAPI.QueryPositionsResponse>;
  querySettledPositionHistory(
    params: W3WPredictionRestAPI.QuerySettledPositionHistoryRequest,
  ): Promise<W3WPredictionRestAPI.QuerySettledPositionHistoryResponse>;
  batchRedeem(
    params: W3WPredictionRestAPI.BatchRedeemRequest,
  ): Promise<W3WPredictionRestAPI.BatchRedeemResponse>;
  getRedeemStatus(
    params: W3WPredictionRestAPI.GetRedeemStatusRequest,
  ): Promise<W3WPredictionRestAPI.GetRedeemStatusResponse>;
}

function payload(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function bookClosePrice(raw: unknown): number | null {
  if (!raw || typeof raw !== "object" || !("closePrice" in raw)) return null;
  return asNumber((raw as { closePrice: unknown }).closePrice);
}

function addVenueRows(
  byToken: Map<string, VenuePositionNumbers>,
  rows:
    | W3WPredictionRestAPI.QueryPositionsResponsePositionsInner[]
    | W3WPredictionRestAPI.QuerySettledPositionHistoryResponsePositionsInner[]
    | undefined,
  tab?: string,
): void {
  for (const row of rows ?? []) {
    const mapped = mapVenuePosition(row);
    if (!mapped.tokenId) continue;
    byToken.set(mapped.tokenId, mergeVenuePosition(byToken.get(mapped.tokenId), mapped, tab));
  }
}

async function stampExpiredClaimTimers(now: Date): Promise<void> {
  const rows = await prisma.position.findMany({
    where: { mode: TradingMode.LIVE, status: PositionStatus.CLOSED },
    include: { market: { include: { topic: { select: { endDate: true } } } } },
  });
  for (const row of rows) {
    const claim = parseClaimState(row.rawPayload);
    if (claim.eligibleAt || isClaimFinished(claim) || isClaimInFlight(claim, now)) continue;
    const expiredFlag =
      Boolean(row.rawPayload && typeof row.rawPayload === "object" && "expired" in row.rawPayload
        ? (row.rawPayload as { expired?: unknown }).expired
        : false);
    const marketEnded = isExpiredAt(now, row.market.topic.endDate);
    if (!expiredFlag && !marketEnded) continue;
    const closedAt = row.closedAt ?? row.market.topic.endDate ?? now;
    const eligibleAt = new Date(closedAt.getTime() + LIVE_CLAIM_DELAY_MS);
    await prisma.position.update({
      where: { id: row.id },
      data: { rawPayload: payload(stampClaimEligibleAt(row.rawPayload, eligibleAt)) },
    });
  }
}


async function ensureVenueOpenRows(
  byToken: Map<string, VenuePositionNumbers>,
): Promise<number> {
  let createdOrRecovered = 0;

  for (const [tokenId, venue] of byToken) {
    if (!(venue.tradableShares != null && venue.tradableShares > 1e-8)) continue;
    if (venue.expired) continue;

    const existingByVenueId = venue.venuePositionId
      ? await prisma.position.findFirst({
          where: {
            mode: TradingMode.LIVE,
            venuePositionId: venue.venuePositionId,
          },
        })
      : null;

    const existingOpen = await prisma.position.findFirst({
      where: {
        mode: TradingMode.LIVE,
        status: PositionStatus.OPEN,
        tokenId,
      },
      orderBy: { openedAt: "desc" },
    });

    if (existingOpen) continue;

    const outcome = await prisma.marketOutcome.findUnique({
      where: { tokenId },
      include: { market: true },
    });
    if (!outcome) {
      log.error(
        { tokenId, shares: venue.tradableShares },
        "Binance has LIVE inventory but token is missing locally",
      );
      continue;
    }

    const latestOrder = await prisma.order.findFirst({
      where: {
        mode: TradingMode.LIVE,
        tokenId,
        side: "BUY",
      },
      orderBy: { createdAt: "desc" },
      select: { strategyId: true, signalId: true },
    });

    const avgPrice = venue.avgPrice ?? 0;
    const totalCost = venue.totalCost ?? venue.tradableShares * avgPrice;

    if (existingByVenueId) {
      await prisma.position.update({
        where: { id: existingByVenueId.id },
        data: {
          status: PositionStatus.OPEN,
          closedAt: null,
          shares: venue.tradableShares,
          avgPrice: avgPrice > 0 ? avgPrice : existingByVenueId.avgPrice,
          totalCost: totalCost > 0 ? totalCost : existingByVenueId.totalCost,
          unrealizedPnl: venue.unrealizedPnl ?? existingByVenueId.unrealizedPnl,
          realizedPnl: venue.realizedPnl ?? existingByVenueId.realizedPnl,
          rawPayload: payload({
            source: "live-venue-recovery",
            recoveredAt: new Date().toISOString(),
            venuePositionId: venue.venuePositionId,
          }),
        },
      });
      createdOrRecovered += 1;
      log.warn(
        { tokenId, positionId: existingByVenueId.id, shares: venue.tradableShares },
        "recovered CLOSED local position from Binance LIVE inventory",
      );
      continue;
    }

    // No local position exists, but Binance says the wallet owns tradable
    // shares. Create a conservative recovery row so the bot cannot open a
    // second position against real inventory. This is intentionally marked
    // as venue-recovered and is never fabricated from a signal.
    await prisma.position.create({
      data: {
        mode: TradingMode.LIVE,
        venuePositionId: venue.venuePositionId ?? undefined,
        strategyId: latestOrder?.strategyId ?? undefined,
        marketId: outcome.marketId,
        outcomeId: outcome.id,
        signalId: latestOrder?.signalId ?? undefined,
        tokenId,
        side: "BUY",
        status: PositionStatus.OPEN,
        shares: venue.tradableShares,
        avgPrice: avgPrice > 0 ? avgPrice : 0,
        totalCost: totalCost > 0 ? totalCost : 0,
        unrealizedPnl: venue.unrealizedPnl ?? 0,
        realizedPnl: venue.realizedPnl ?? 0,
        rawPayload: {
          source: "live-venue-recovery",
          recoveredAt: new Date().toISOString(),
          venuePositionId: venue.venuePositionId,
        },
      },
    });
    createdOrRecovered += 1;
    log.warn(
      { tokenId, shares: venue.tradableShares, marketId: outcome.marketId },
      "created LIVE recovery position from Binance inventory",
    );
  }

  return createdOrRecovered;
}

async function overlayVenueNumbers(
  byToken: Map<string, VenuePositionNumbers>,
  now: Date,
): Promise<{ updated: number; realizedDelta: number }> {
  if (byToken.size === 0) return { updated: 0, realizedDelta: 0 };
  const rows = await prisma.position.findMany({
    where: { mode: TradingMode.LIVE, tokenId: { in: [...byToken.keys()] } },
    orderBy: { openedAt: "desc" },
  });
  const seen = new Set<string>();
  let updated = 0;
  let realizedDelta = 0;
  for (const row of rows) {
    const venue = byToken.get(row.tokenId);
    if (!venue) continue;
    const already = seen.has(row.tokenId);
    seen.add(row.tokenId);
    if (already && !(row.status === PositionStatus.OPEN && venue.expired)) continue;
    const data: Prisma.PositionUpdateInput = {};
    const extra: Record<string, unknown> =
      row.rawPayload && typeof row.rawPayload === "object" && !Array.isArray(row.rawPayload)
        ? { ...(row.rawPayload as Record<string, unknown>) }
        : {};
    const bookClose = bookClosePrice(row.rawPayload);
    const settled = venue.expired === true;
    const localRealized = asNumber(row.realizedPnl) ?? 0;
    const remainingCost = asNumber(row.totalCost) ?? 0;
    const marketEndMs = row.market.topic.endDate?.getTime() ?? null;
    const closedAtMs = row.closedAt?.getTime() ?? null;
    // A row that was closed by an EXIT before the market ended must keep its
    // trade PnL. Only a position that was still held at expiry is eligible
    // for settlement PnL reconstruction.
    const liveDust = Boolean(
      row.rawPayload &&
      typeof row.rawPayload === "object" &&
      !Array.isArray(row.rawPayload) &&
      (row.rawPayload as { liveDust?: unknown }).liveDust === true,
    );
    const heldAtSettlement =
      settled &&
      (liveDust || closedAtMs == null || marketEndMs == null || closedAtMs >= marketEndMs);
    let rowRealizedDelta = 0;

    if (venue.venuePositionId) data.venuePositionId = venue.venuePositionId;
    if (venue.claimAmount != null) extra.claimAmount = venue.claimAmount;
    if (venue.tradableShares != null) extra.venueTradableShares = venue.tradableShares;
    if (venue.avgPrice != null) extra.venueAvgPrice = venue.avgPrice;
    if (venue.totalCost != null) extra.venueTotalCost = venue.totalCost;

    const effectiveRealized = settledRealizedPnl({
      localRealized,
      remainingCost,
      venueRealizedPnl: venue.realizedPnl,
      claimAmount: venue.claimAmount,
      heldAtSettlement,
    });

    if (effectiveRealized != null) {
      extra.venueRealizedPnl = effectiveRealized;
      rowRealizedDelta = effectiveRealized - localRealized;
      data.realizedPnl = effectiveRealized;
      if (heldAtSettlement && venue.claimAmount != null &&
          (venue.realizedPnl == null || Math.abs(venue.realizedPnl) < 1e-12) &&
          Math.abs(rowRealizedDelta) > 1e-12) {
        extra.settlementRealizedPnl = effectiveRealized;
        extra.settlementPnlSource = "claimAmount-minus-remaining-cost";
      }
    }
    if (venue.unrealizedPnl != null) extra.venueUnrealizedPnl = venue.unrealizedPnl;

    if (row.status === PositionStatus.OPEN && !settled) {
      if (venue.tradableShares != null) data.shares = venue.tradableShares;
      if (venue.avgPrice != null) data.avgPrice = venue.avgPrice;
      if (venue.totalCost != null) data.totalCost = venue.totalCost;
      if (venue.unrealizedPnl != null) data.unrealizedPnl = venue.unrealizedPnl;
    }

    if (row.status === PositionStatus.OPEN && settled) {
      data.status = PositionStatus.CLOSED;
      data.closedAt = row.closedAt ?? now;
      if (venue.closePrice != null && (bookClose == null || bookClose <= 0)) {
        extra.closePrice = venue.closePrice;
      }
      Object.assign(extra, clearLiveFlatten(stampClaimEligibleAt(extra, new Date((row.closedAt ?? now).getTime() + LIVE_CLAIM_DELAY_MS))));
      data.rawPayload = payload(extra);
    } else if (row.status === PositionStatus.CLOSED) {
      if (settled && venue.closePrice != null && (bookClose == null || extra.expired === true)) {
        extra.closePrice = venue.closePrice;
      }
      if (settled) {
        if (liveDust && !row.closedAt) data.closedAt = now;
        Object.assign(extra, clearLiveFlatten(extra));
      }
      data.rawPayload = payload(extra);
    } else if (venue.claimAmount != null) {
      data.rawPayload = payload(extra);
    }

    if (Object.keys(data).length === 0) continue;
    try {
      await prisma.position.update({ where: { id: row.id }, data });
      realizedDelta += rowRealizedDelta;
      updated += 1;
    } catch (error) {
      log.warn({ err: String(error), tokenId: row.tokenId }, "venue overlay skipped");
      if (data.venuePositionId) {
        delete data.venuePositionId;
        try {
          await prisma.position.update({ where: { id: row.id }, data });
          realizedDelta += rowRealizedDelta;
          updated += 1;
        } catch (retryError) {
          log.warn({ err: String(retryError), tokenId: row.tokenId }, "venue overlay retry skipped");
        }
      }
    }
  }
  return { updated, realizedDelta };
}

async function refreshPendingRedeems(
  venue: LivePositionVenue,
  walletAddress: string,
): Promise<void> {
  const rows = await prisma.position.findMany({
    where: { mode: TradingMode.LIVE },
  });
  for (const row of rows) {
    const claim = parseClaimState(row.rawPayload);
    if (!claim.txHash || isClaimFinished(claim) || !isClaimInFlight(claim)) continue;
    try {
      const result = await venue.getRedeemStatus({
        walletAddress,
        txHash: claim.txHash,
      });
      const status = result.status ?? claim.status;
      await prisma.position.update({
        where: { id: row.id },
        data: {
          rawPayload: payload(mergeClaimState(row.rawPayload, { status: status ?? claim.status })),
        },
      });
    } catch (error) {
      log.warn({ err: String(error), tokenId: row.tokenId }, "redeem status skipped");
    }
  }
}

function isExpiredPayload(raw: unknown): boolean {
  return Boolean(
    raw && typeof raw === "object" && (raw as { expired?: unknown }).expired === true,
  );
}

async function redeemEligible(
  venue: LivePositionVenue,
  ctx: LiveTradeContext,
  byToken: Map<string, VenuePositionNumbers>,
  now: Date,
  immediate = false,
): Promise<number> {
  const rows = await prisma.position.findMany({
    where: { mode: TradingMode.LIVE },
  });
  const ready: Array<{ id: string; tokenId: string; failedBefore: boolean }> = [];
  let lastStartedAt: Date | null = null;
  for (const row of rows) {
    const claim = parseClaimState(row.rawPayload);
    if (claim.startedAt) {
      const started = new Date(claim.startedAt);
      if (!lastStartedAt || started > lastStartedAt) lastStartedAt = started;
    }
    const venueRow = byToken.get(row.tokenId);
    if (
      !shouldClaimPosition({
        now,
        expired: isExpiredPayload(row.rawPayload) || Boolean(venueRow?.expired),
        claim,
        canClaim: venueRow?.canClaim === true,
        claimAmount: venueRow?.claimAmount ?? null,
        immediate,
      })
    ) {
      continue;
    }
    ready.push({
      id: row.id,
      tokenId: row.tokenId,
      failedBefore: claim.status?.toUpperCase() === "FAILED",
    });
  }
  if (immediate) {
    for (const [tokenId, venueRow] of byToken) {
      if (ready.some((row) => row.tokenId === tokenId)) continue;
      if (!venueRow.canClaim && !(venueRow.claimAmount != null && venueRow.claimAmount > 0)) {
        continue;
      }
      ready.push({ id: `venue:${tokenId}`, tokenId, failedBefore: false });
    }
  }
  const allIds = pickClaimTokenIds(ready.map((row) => row.tokenId));
  if (allIds.length === 0) return 0;
  const tokenIds =
    ready.every((row) => row.failedBefore) && allIds.length > 1
      ? pickSingleClaimToken(allIds, lastStartedAt, now)
      : allIds;
  if (tokenIds.length === 0) return 0;

  const applyStarted = async (ids: string[], patch: Parameters<typeof mergeClaimState>[1]) => {
    const want = new Set(ids);
    for (const row of ready) {
      if (!want.has(row.tokenId) || row.id.startsWith("venue:")) continue;
      const current = await prisma.position.findUnique({
        where: { id: row.id },
        select: { rawPayload: true },
      });
      await prisma.position.update({
        where: { id: row.id },
        data: { rawPayload: payload(mergeClaimState(current?.rawPayload, patch)) },
      });
    }
  };

  const startedAt = now.toISOString();
  await applyStarted(tokenIds, { startedAt, status: "PENDING" });
  try {
    const result = await venue.batchRedeem({
      walletAddress: ctx.walletAddress,
      walletId: ctx.walletId,
      tokenIds,
    });
    const txHash =
      result.results?.find((item) => item.txHash)?.txHash ?? result.results?.[0]?.txHash;
    const failed = result.results?.length
      ? result.results.every((item) => item.status === "FAILED")
      : false;
    const status = failed ? "FAILED" : (result.results?.[0]?.status ?? "PENDING");
    await applyStarted(tokenIds, { startedAt, txHash: txHash ?? undefined, status });
    log.info({ tokenIds, batchId: result.batchId, txHash, status }, "live batchRedeem");
    return failed ? 0 : tokenIds.length;
  } catch (error) {
    await applyStarted(tokenIds, { startedAt, status: "FAILED" });
    log.warn({ err: String(error), tokenIds }, "live batchRedeem failed");
    return 0;
  }
}

async function loadVenuePositions(
  venue: LivePositionVenue,
  ctx: LiveTradeContext,
  options: { includeEnded?: boolean } = {},
): Promise<Map<string, VenuePositionNumbers>> {
  const byToken = new Map<string, VenuePositionNumbers>();
  // Only ONGOING/PENDING_CLAIM are needed during normal position sync.
  // ENDED is loaded from settled-position history only when an explicit
  // settlement/claim pass is required; otherwise an old ENDED row can
  // overwrite a locally recorded trade result with a zero PnL value.
  for (const tab of VENUE_POSITION_TABS.filter((value) => value !== "ENDED")) {
    try {
      const page = await venue.queryPositions({
        walletAddress: ctx.walletAddress,
        tab,
        limit: 100,
      });
      addVenueRows(byToken, page.positions, tab);
      if (tab === "PENDING_CLAIM") {
        log.info(
          { pendingClaim: page.positions?.length ?? 0 },
          "live queryPositions PENDING_CLAIM",
        );
      }
    } catch (error) {
      log.warn({ err: String(error), tab }, "queryPositions skipped");
    }
  }
  // ENDED history is not needed to maintain an OPEN position. ONGOING and
  // PENDING_CLAIM are the authoritative live inventory states. Querying the
  // full settled history every trading cycle adds a high-latency REST call
  // and can delay a real-money EXIT. Fetch it only for explicit claim/recovery
  // passes.
  if (options.includeEnded) {
    try {
      const settled = await venue.querySettledPositionHistory({
        walletAddress: ctx.walletAddress,
        limit: 100,
      });
      addVenueRows(byToken, settled.positions, "ENDED");
    } catch (error) {
      log.warn({ err: String(error) }, "querySettledPositionHistory skipped");
    }
  }
  return byToken;
}

async function persistVenueRealizedDelta(delta: number, now: Date): Promise<void> {
  if (!Number.isFinite(delta) || Math.abs(delta) < 1e-12) return;
  try {
    const state = await loadRiskState();
    const limits = limitsFromEnv();
    const next = recordClosedTrade(
      { ...state, mode: TradingMode.LIVE },
      delta,
      now,
      limits,
    );
    const open = await prisma.position.findMany({
      where: { mode: TradingMode.LIVE, status: PositionStatus.OPEN },
      select: { shares: true, avgPrice: true },
    });
    const openNotional = open.reduce(
      (sum, row) => sum + (asNumber(row.shares) ?? 0) * (asNumber(row.avgPrice) ?? 0),
      0,
    );
    await persistRiskSnapshot({
      ...next.state,
      mode: TradingMode.LIVE,
      openPositions: open.length,
      openNotional,
    });
  } catch (error) {
    log.warn({ err: String(error), delta }, "venue realized PnL risk sync skipped");
  }
}

/**
 * Overlay Binance shares/PnL. Binance remains authoritative for live inventory,
 * average price and settled PnL; local DB is retained as the execution ledger.
 * Does not call batchRedeem — claim is a separate pass so ENTER is not blocked.
 */
export async function syncLivePositionsFromVenue(
  venue: LivePositionVenue,
  ctx: LiveTradeContext,
  options: { immediate?: boolean; claim?: boolean } = {},
): Promise<{ updated: number; claimed: number }> {
  const now = new Date();
  await stampExpiredClaimTimers(now);
  const expiredOpen = await prisma.position.findMany({
    where: {
      mode: TradingMode.LIVE,
      status: PositionStatus.OPEN,
      market: { topic: { endDate: { lte: now } } },
    },
    select: { tokenId: true },
  });
  // Also revisit CLOSED rows with zero realized PnL after market expiry.
  // Losing settled positions can legitimately have claimAmount=0 while the
  // venue's realizedPnl/pnl field is also reported as 0. The settled-history
  // pass is needed to reconstruct the actual loss and persist it, otherwise a
  // page refresh can show 0 forever. The closedAt guard avoids touching rows
  // that were fully exited before expiry.
  const zeroRealizedSettled = await prisma.position.findMany({
    where: {
      mode: TradingMode.LIVE,
      status: PositionStatus.CLOSED,
      realizedPnl: 0,
      market: { topic: { endDate: { lte: now } } },
    },
    select: { id: true, tokenId: true, closedAt: true, market: { select: { topic: { select: { endDate: true } } } } },
  });
  const zeroRealizedAfterExpiry = zeroRealizedSettled.filter((row) => {
    const end = row.market.topic.endDate?.getTime() ?? null;
    const closed = row.closedAt?.getTime() ?? null;
    return end != null && (closed == null || closed >= end);
  });
  const byToken = await loadVenuePositions(
    venue,
    ctx,
    { includeEnded: options.immediate === true || expiredOpen.length > 0 || zeroRealizedAfterExpiry.length > 0 },
  );
  const recovered = await ensureVenueOpenRows(byToken);
  const overlay = await overlayVenueNumbers(byToken, now);
  await persistVenueRealizedDelta(overlay.realizedDelta, now);
  await stampExpiredClaimTimers(now);
  if (options.claim === false && options.immediate !== true) {
    return { updated: overlay.updated + recovered, claimed: 0 };
  }
  await refreshPendingRedeems(venue, ctx.walletAddress);
  const claimed = await redeemEligible(venue, ctx, byToken, now, options.immediate === true);
  return { updated: overlay.updated + recovered, claimed };
}

/** batchRedeem / redeem-status only. Safe to run after ENTER or in the background. */
export async function claimLiveWinnings(
  venue: LivePositionVenue,
  ctx: LiveTradeContext,
  options: { immediate?: boolean } = {},
): Promise<{ claimed: number }> {
  const now = new Date();
  await stampExpiredClaimTimers(now);
  const byToken = await loadVenuePositions(venue, ctx, { includeEnded: true });
  const overlay = await overlayVenueNumbers(byToken, now);
  await persistVenueRealizedDelta(overlay.realizedDelta, now);
  await refreshPendingRedeems(venue, ctx.walletAddress);
  const claimed = await redeemEligible(venue, ctx, byToken, now, options.immediate === true);
  return { claimed };
}
