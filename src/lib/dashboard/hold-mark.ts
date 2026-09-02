import { mtmEquity, sumOpenUnrealized } from "@/lib/dashboard/equity";
import { unrealizedPnl } from "@/lib/dashboard/mark";
import type { DashboardPayload, DashboardPosition } from "@/lib/dashboard/types";

export function stabilizePositionMarks(
  previous: DashboardPosition[] | undefined,
  next: DashboardPosition[],
): DashboardPosition[] {
  const prevById = new Map((previous ?? []).map((row) => [row.id, row]));
  return next.map((row) => {
    if (row.status !== "OPEN") {
      return { ...row, mark: null, markSource: "none", unrealizedPnl: null, markHeld: false };
    }
    if (row.mark !== null) {
      return { ...row, markHeld: false };
    }
    const held = prevById.get(row.id);
    if (!held || held.mark === null || held.markSource === "none") {
      return { ...row, markHeld: false };
    }
    return {
      ...row,
      mark: held.mark,
      markSource: held.markSource,
      unrealizedPnl: unrealizedPnl(row.side, row.avgPrice, row.shares, held.mark),
      markHeld: true,
    };
  });
}

export function applyHeldMarks(previous: DashboardPayload | null, next: DashboardPayload): DashboardPayload {
  const positions = stabilizePositionMarks(previous?.positions, next.positions);
  const openMark = sumOpenUnrealized(positions);
  return {
    ...next,
    positions,
    risk: {
      ...next.risk,
      unrealizedPnl: openMark.pnl,
      openMissingMark: openMark.missingMark,
      mtmEquity: mtmEquity(next.risk.realizedEquity, openMark.pnl),
    },
  };
}
