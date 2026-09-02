export const LEDGER_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

export function parseLedgerPage(raw: string | null, fallback = 1): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return n;
}

export function parseLedgerPageSize(raw: string | null, fallback = LEDGER_PAGE_SIZE): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return Math.min(n, MAX_PAGE_SIZE);
}

export function ledgerSkip(page: number, pageSize: number): number {
  return (Math.max(1, page) - 1) * pageSize;
}

export function ledgerPageCount(total: number, pageSize: number): number {
  if (pageSize <= 0) return 1;
  return Math.max(1, Math.ceil(total / pageSize));
}

export function slicePage<T>(rows: T[], page: number, pageSize: number): T[] {
  const start = ledgerSkip(page, pageSize);
  return rows.slice(start, start + pageSize);
}
