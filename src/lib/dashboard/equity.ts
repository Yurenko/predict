export function sumClosedRealized(
  positions: Array<{ status: string; realizedPnl: number }>,
): number {
  return positions
    .filter((row) => row.status === "CLOSED")
    .reduce((sum, row) => sum + row.realizedPnl, 0);
}

export function sumOpenUnrealized(
  positions: Array<{ status: string; unrealizedPnl: number | null }>,
): { pnl: number; missingMark: number } {
  let pnl = 0;
  let missingMark = 0;
  for (const row of positions) {
    if (row.status !== "OPEN") continue;
    if (row.unrealizedPnl === null) {
      missingMark += 1;
      continue;
    }
    pnl += row.unrealizedPnl;
  }
  return { pnl, missingMark };
}

export function mtmEquity(realizedEquity: number, openUnrealized: number): number {
  return realizedEquity + openUnrealized;
}
