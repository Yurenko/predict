import { PositionStatus, Prisma, TradingMode } from "@prisma/client";
import type { W3WPredictionRestAPI } from "@binance/w3w-prediction";
import { prisma } from "@/lib/db/prisma";
import { childLogger } from "@/lib/logger";
import { isExpiredAt } from "@/lib/markets/settlement";
import type { LiveTradeContext } from "@/lib/live/engine";
import {
  LIVE_CLAIM_DELAY_MS,
  isClaimFinished,
  isClaimInFlight,
  mapVenuePosition,
  mergeClaimState,
  mergeVenuePosition,
  parseClaimState,
  pickClaimTokenIds,
  pickSingleClaimToken,
  shouldClaimPosition,
  stampClaimEligibleAt,
  type VenuePositionNumbers,
} from "@/lib/live/claim";
import { clearLiveFlatten } from "@/lib/live/flatten";
import { asNumber } from "@/lib/normalize/numbers";
import { limitsFromEnv } from "@/lib/risk/limits";
import { loadRiskState, persistRiskSnapshot } from "@/lib/risk/persist";
import { recordClosedTrade } from "@/lib/risk/state";
import { calculateLiveRealizedPnl, liveSettlementReady } from "@/lib/live/realized-pnl";
import {
  liveOverlayWriteNeeded,
  livePositionTabs,
  shouldAssignLiveVenuePositionId,
} from "@/lib/live/sync-scope";

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

function settlementReadyAt(endDate: Date | null | undefined, fallback: Date): Date {
  const base = endDate ?? fallback;
  return new Date(base.getTime() + LIVE_CLAIM_DELAY_MS);
}

type VenuePositionIndex = {
  byToken: Map<string, VenuePositionNumbers>;
  byVenuePositionId: Map<string, VenuePositionNumbers>;
};

function tabPriority(tab?: string): number {
  if (tab === "ONGOING") return 3;
  if (tab === "PENDING_CLAIM") return 2;
  if (tab === "ENDED") return 1;
  return 0;
}

function addVenueRows(
  index: VenuePositionIndex,
  rows:
    | W3WPredictionRestAPI.QueryPositionsResponsePositionsInner[]
    | W3WPredictionRestAPI.QuerySettledPositionHistoryResponsePositionsInner[]
    | undefined,
  tab?: string,
): void {
  for (const row of rows ?? []) {
    const mapped = mapVenuePosition(row);
    if (!mapped.tokenId) continue;

    const venueId = mapped.venuePositionId;
    if (venueId) {
      const previousById = index.byVenuePositionId.get(venueId);
      index.byVenuePositionId.set(
        venueId,
        mergeVenuePosition(previousById, mapped, tab),
      );
    }

    // A token can have multiple historical venue positions. Never let an ENDED
    // row overwrite an ONGOING row for token-based fallback matching. Exact
    // venuePositionId matching is preferred everywhere once it is known.
    const previous = index.byToken.get(mapped.tokenId);
    const previousPriority = Number(
      previous && typeof (previous as VenuePositionNumbers & { __tabPriority?: number }).__tabPriority === "number"
        ? (previous as VenuePositionNumbers & { __tabPriority?: number }).__tabPriority
        : 0,
    );
    const next = mergeVenuePosition(previous, mapped, tab) as VenuePositionNumbers & { __tabPriority?: number };
    if (!previous || tabPriority(tab) >= previousPriority) {
      next.__tabPriority = tabPriority(tab);
      index.byToken.set(mapped.tokenId, next);
    }
  }
}

function stripVenueIndexMeta(value: VenuePositionNumbers): VenuePositionNumbers {
  const clone = { ...(value as VenuePositionNumbers & { __tabPriority?: number }) };
  delete (clone as VenuePositionNumbers & { __tabPriority?: number }).__tabPriority;
  return clone;
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
  index: VenuePositionIndex,
): Promise<number> {
  let createdOrRecovered = 0;

  for (const [tokenId, rawVenue] of index.byToken) {
    const venue = stripVenueIndexMeta(rawVenue);
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

async function loadVenuePositionOwners(venueIds: string[]): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  if (venueIds.length === 0) return owners;
  const rows = await prisma.position.findMany({
    where: { mode: TradingMode.LIVE, venuePositionId: { in: venueIds } },
    select: { id: true, venuePositionId: true },
    orderBy: { openedAt: "desc" },
  });
  for (const row of rows) {
    if (row.venuePositionId && !owners.has(row.venuePositionId)) {
      owners.set(row.venuePositionId, row.id);
    }
  }
  return owners;
}

async function overlayVenueNumbers(
  index: VenuePositionIndex,
  now: Date,
  options: { inventoryOnly?: boolean } = {},
): Promise<{ updated: number; realizedDelta: number }> {
  if (index.byToken.size === 0 && index.byVenuePositionId.size === 0) return { updated: 0, realizedDelta: 0 };
  const tokenIds = [...index.byToken.keys()];
  const venueIds = [...index.byVenuePositionId.keys()];
  const inventoryOnly = options.inventoryOnly === true;
  const rows = await prisma.position.findMany({
    where: {
      mode: TradingMode.LIVE,
      ...(inventoryOnly ? { status: PositionStatus.OPEN } : {}),
      OR: [
        ...(tokenIds.length > 0
          ? inventoryOnly
            ? [{ tokenId: { in: tokenIds } }]
            : [{ status: PositionStatus.OPEN, tokenId: { in: tokenIds } }]
          : []),
        ...(venueIds.length > 0 ? [{ venuePositionId: { in: venueIds } }] : []),
      ],
    },
    orderBy: { openedAt: "desc" },
    include: {
      market: { select: { topic: { select: { endDate: true } } } },
      executions: {
        orderBy: { executedAt: "asc" },
        include: {
          order: {
            select: {
              side: true,
              fees: { select: { amount: true } },
            },
          },
        },
      },
    },
  });
  const owners = await loadVenuePositionOwners(venueIds);
  const seen = new Set<string>();
  let updated = 0;
  let realizedDelta = 0;
  for (const row of rows) {
    const raw =
      row.rawPayload && typeof row.rawPayload === "object" && !Array.isArray(row.rawPayload)
        ? (row.rawPayload as Record<string, unknown>)
        : {};
    const rawVenuePositionId =
      row.venuePositionId ??
      (typeof raw.venuePositionId === "string" ? raw.venuePositionId : null);
    const exactVenue = rawVenuePositionId
      ? index.byVenuePositionId.get(rawVenuePositionId)
      : undefined;
    // Token fallback is safe only for an OPEN row that has not yet been pinned
    // to a Binance venuePositionId. Closed rows must never receive another
    // historical position's numbers merely because they share a tokenId.
    const fallbackVenue = row.status === PositionStatus.OPEN
      ? index.byToken.get(row.tokenId)
      : undefined;
    const venue = exactVenue ?? fallbackVenue;
    if (!venue) continue;
    const already = seen.has(row.id);
    seen.add(row.id);
    if (already) continue;
    const data: Prisma.PositionUpdateInput = {};
    const extra: Record<string, unknown> =
      row.rawPayload && typeof row.rawPayload === "object" && !Array.isArray(row.rawPayload)
        ? { ...(row.rawPayload as Record<string, unknown>) }
        : {};
    if (
      venue.venuePositionId &&
      shouldAssignLiveVenuePositionId({
        rowId: row.id,
        ownerId: owners.get(venue.venuePositionId),
      })
    ) {
      extra.venuePositionId = venue.venuePositionId;
      data.venuePositionId = venue.venuePositionId;
    }
    const bookClose = bookClosePrice(row.rawPayload);
    const settled = venue.expired === true;
    const rawExpired = extra.expired === true;
    const closedBeforeExpiry =
      row.status === PositionStatus.CLOSED &&
      row.closedAt != null &&
      row.market.topic.endDate != null &&
      row.closedAt.getTime() < row.market.topic.endDate.getTime();
    // A position that was fully exited before market expiry must keep its
    // execution PnL. Settled-history PnL belongs to the unresolved venue
    // position and must not overwrite a pre-expiry local close.
    const settlementRelevant = !closedBeforeExpiry || rawExpired;
    const settlementReady =
      !settled ||
      now.getTime() >= settlementReadyAt(row.market.topic.endDate, row.closedAt ?? now).getTime();
    const localRealized = asNumber(row.realizedPnl) ?? 0;
    let rowRealizedDelta = 0;

    if (
      venue.venuePositionId &&
      shouldAssignLiveVenuePositionId({
        rowId: row.id,
        ownerId: owners.get(venue.venuePositionId),
      })
    ) {
      data.venuePositionId = venue.venuePositionId;
    }
    if (venue.claimAmount != null) extra.claimAmount = venue.claimAmount;
    if (venue.settlementValue != null) extra.venueSettlementValue = venue.settlementValue;
    if (venue.tradableShares != null) extra.venueTradableShares = venue.tradableShares;
    if (venue.avgPrice != null) extra.venueAvgPrice = venue.avgPrice;
    if (venue.totalCost != null) extra.venueTotalCost = venue.totalCost;
    const canonicalSettlementReady = settled && settlementRelevant && settlementReady;
    const canonicalRealized = calculateLiveRealizedPnl(
      {
        executions: row.executions,
        rawPayload: row.rawPayload,
        closedAt: row.closedAt,
        endDate: row.market.topic.endDate,
      },
      {
        includeSettlement: canonicalSettlementReady,
        settlementValue: venue.settlementValue ?? venue.claimAmount,
      },
    );

    // Rebuild the cached DB value from executions + one settlement leg. This
    // is deliberately idempotent: polling the same Binance settled position
    // again must write the same number, not add the settlement delta again.
    if (Number.isFinite(canonicalRealized) && Math.abs(canonicalRealized - localRealized) > 1e-10) {
      data.realizedPnl = canonicalRealized;
      rowRealizedDelta = canonicalRealized - localRealized;
    }
    if (venue.realizedPnl != null) extra.venueRealizedPnl = venue.realizedPnl;
    if (canonicalSettlementReady) {
      const settlementValue = venue.settlementValue ?? venue.claimAmount;
      if (settlementValue != null) {
        extra.venueSettlementValue = settlementValue;
        extra.liveSettlementApplied = true;
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
      extra.settlementReadyAt = settlementReadyAt(row.market.topic.endDate, row.closedAt ?? now).toISOString();
      extra.settlementReady = settlementReady;
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
        extra.settlementReadyAt = settlementReadyAt(row.market.topic.endDate, row.closedAt ?? now).toISOString();
        extra.settlementReady = settlementReady;
        Object.assign(extra, clearLiveFlatten(extra));
      }
      data.rawPayload = payload(extra);
    } else if (venue.claimAmount != null) {
      data.rawPayload = payload(extra);
    }

    if (Object.keys(data).length === 0) continue;
    if (
      !liveOverlayWriteNeeded(
        {
          status: row.status,
          shares: row.shares,
          avgPrice: row.avgPrice,
          totalCost: row.totalCost,
          realizedPnl: row.realizedPnl,
          unrealizedPnl: row.unrealizedPnl,
          venuePositionId: row.venuePositionId,
          closedAt: row.closedAt,
        },
        {
          status: typeof data.status === "string" ? data.status : undefined,
          shares: data.shares,
          avgPrice: data.avgPrice,
          totalCost: data.totalCost,
          realizedPnl: data.realizedPnl,
          unrealizedPnl: data.unrealizedPnl,
          venuePositionId:
            typeof data.venuePositionId === "string" ? data.venuePositionId : undefined,
          closedAt: data.closedAt instanceof Date ? data.closedAt : undefined,
          rawPayload: data.rawPayload,
        },
      )
    ) {
      continue;
    }
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


async function canonicalizeLiveRealizedCache(now: Date): Promise<{ changed: number; realizedDelta: number }> {
  const recentClosedAfter = new Date(now.getTime() - 24 * 60 * 60_000);
  const rows = await prisma.position.findMany({
    where: {
      mode: TradingMode.LIVE,
      OR: [
        { status: PositionStatus.OPEN },
        { closedAt: { gte: recentClosedAfter } },
      ],
    },
    include: {
      market: { select: { topic: { select: { endDate: true } } } },
      executions: {
        orderBy: { executedAt: "asc" },
        include: {
          order: {
            select: {
              side: true,
              fees: { select: { amount: true } },
            },
          },
        },
      },
    },
  });

  let changed = 0;
  let realizedDelta = 0;
  for (const row of rows) {
    const raw =
      row.rawPayload && typeof row.rawPayload === "object" && !Array.isArray(row.rawPayload)
        ? (row.rawPayload as Record<string, unknown>)
        : {};
    const settlementReady = liveSettlementReady({
      rawPayload: row.rawPayload,
      closedAt: row.closedAt,
      endDate: row.market.topic.endDate,
      now,
      delayMs: LIVE_CLAIM_DELAY_MS,
    });

    const canonical = calculateLiveRealizedPnl(
      {
        executions: row.executions,
        rawPayload: row.rawPayload,
        closedAt: row.closedAt,
        endDate: row.market.topic.endDate,
      },
      {
        includeSettlement: settlementReady,
      },
    );
    const current = asNumber(row.realizedPnl) ?? 0;
    if (!Number.isFinite(canonical) || Math.abs(canonical - current) <= 1e-10) continue;

    const nextRaw = {
      ...raw,
      livePnlCanonicalizedAt: now.toISOString(),
      livePnlCanonical: canonical,
      ...(settlementReady ? { liveSettlementApplied: true } : {}),
    };
    await prisma.position.update({
      where: { id: row.id },
      data: {
        realizedPnl: canonical,
        rawPayload: payload(nextRaw),
      },
    });
    changed += 1;
    realizedDelta += canonical - current;
  }
  return { changed, realizedDelta };
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
  index: VenuePositionIndex,
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
    const venueRow = row.venuePositionId
      ? index.byVenuePositionId.get(row.venuePositionId)
      : row.status === PositionStatus.OPEN
        ? index.byToken.get(row.tokenId)
        : undefined;
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
    for (const [tokenId, rawVenueRow] of index.byToken) {
      const venueRow = stripVenueIndexMeta(rawVenueRow);
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
  options: { includeEnded?: boolean; settledHistory?: boolean } = {},
): Promise<VenuePositionIndex> {
  const index: VenuePositionIndex = {
    byToken: new Map<string, VenuePositionNumbers>(),
    byVenuePositionId: new Map<string, VenuePositionNumbers>(),
  };
  for (const tab of livePositionTabs(options.includeEnded === true)) {
    try {
      const page = await venue.queryPositions({
        walletAddress: ctx.walletAddress,
        tab,
        limit: 100,
      });
      addVenueRows(index, page.positions, tab);
      if (tab === "PENDING_CLAIM" && (page.positions?.length ?? 0) > 0) {
        log.info(
          { pendingClaim: page.positions?.length ?? 0 },
          "live queryPositions PENDING_CLAIM",
        );
      }
    } catch (error) {
      log.warn({ err: String(error), tab }, "queryPositions skipped");
    }
  }
  // Settled history is claim/recovery only. The trading tick only needs
  // ONGOING + PENDING_CLAIM so ENTER/EXIT are not waiting on ENDED REST.
  if (options.settledHistory) {
    try {
      const settled = await venue.querySettledPositionHistory({
        walletAddress: ctx.walletAddress,
        limit: 100,
      });
      addVenueRows(index, settled.positions, "ENDED");
    } catch (error) {
      log.warn({ err: String(error) }, "querySettledPositionHistory skipped");
    }
  }
  return index;
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
  const ledger = options.claim !== false || options.immediate === true;
  const expiredOpen = await prisma.position.findMany({
    where: {
      mode: TradingMode.LIVE,
      status: PositionStatus.OPEN,
      market: { topic: { endDate: { lte: now } } },
    },
    select: { tokenId: true },
  });
  if (ledger) await stampExpiredClaimTimers(now);
  const index = await loadVenuePositions(venue, ctx, {
    includeEnded: ledger || expiredOpen.length > 0,
    settledHistory: ledger,
  });
  const recovered = await ensureVenueOpenRows(index);
  const overlay = await overlayVenueNumbers(index, now, { inventoryOnly: !ledger });
  let canonicalized = { changed: 0, realizedDelta: 0 };
  if (ledger) {
    canonicalized = await canonicalizeLiveRealizedCache(now);
    if (canonicalized.changed > 0) {
      log.info({ canonicalized: canonicalized.changed }, "LIVE realized PnL cache repaired");
    }
    await stampExpiredClaimTimers(now);
  }
  await persistVenueRealizedDelta(overlay.realizedDelta + canonicalized.realizedDelta, now);
  if (!ledger) {
    return { updated: overlay.updated + recovered, claimed: 0 };
  }
  await refreshPendingRedeems(venue, ctx.walletAddress);
  const claimed = await redeemEligible(venue, ctx, index, now, options.immediate === true);
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
  const index = await loadVenuePositions(venue, ctx, {
    includeEnded: true,
    settledHistory: true,
  });
  const overlay = await overlayVenueNumbers(index, now);
  const canonicalized = await canonicalizeLiveRealizedCache(now);
  if (canonicalized.changed > 0) {
    log.info({ canonicalized: canonicalized.changed }, "LIVE realized PnL cache repaired");
  }
  await persistVenueRealizedDelta(overlay.realizedDelta + canonicalized.realizedDelta, now);
  await refreshPendingRedeems(venue, ctx.walletAddress);
  const claimed = await redeemEligible(venue, ctx, index, now, options.immediate === true);
  return { claimed };
}
