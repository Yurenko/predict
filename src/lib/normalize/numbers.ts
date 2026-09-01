export function asId(value: unknown): string | null {
  if (typeof value === "string" && value) return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return null;
}

export function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "toNumber" in value &&
    typeof (value as { toNumber: unknown }).toNumber === "function"
  ) {
    const parsed = (value as { toNumber: () => number }).toNumber();
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function asDecimalString(value: unknown): string | null {
  const n = asNumber(value);
  if (n === null) return null;
  if (Number.isInteger(n)) return n.toString();
  return n.toFixed(12).replace(/\.?0+$/, "");
}

export function asDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const n = asNumber(value);
  if (n === null) return null;
  const ms = n > 1_000_000_000_000 ? n : n * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function sumLevels(
  levels: Array<[string, string]>,
): { size: number; notional: number } {
  let size = 0;
  let notional = 0;
  for (const [price, qty] of levels) {
    const p = asNumber(price) ?? 0;
    const q = asNumber(qty) ?? 0;
    size += q;
    notional += p * q;
  }
  return { size, notional };
}
