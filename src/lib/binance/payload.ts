import { createHash } from "node:crypto";

const MAX_FUTURE_DRIFT_MS = 5_000;

export function toJsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(toJsonSafe);
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, nested]) => [key, toJsonSafe(nested)],
    );
    return Object.fromEntries(entries);
  }
  return value;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(toJsonSafe(value));
}

export function payloadHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function parseObservedAt(value: unknown, fallback = new Date()): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return validateTimestamp(value);
  }
  if (typeof value === "bigint") {
    return parseObservedAt(Number(value), fallback);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 1_000_000_000_000 ? value : value * 1000;
    return validateTimestamp(new Date(ms));
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && /^\d+(\.\d+)?$/.test(value.trim())) {
      return parseObservedAt(numeric, fallback);
    }
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return validateTimestamp(parsed);
    }
  }
  return validateTimestamp(fallback);
}

export function validateTimestamp(date: Date, now = Date.now()): Date | null {
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  if (date.getTime() - now > MAX_FUTURE_DRIFT_MS) {
    return null;
  }
  return date;
}
