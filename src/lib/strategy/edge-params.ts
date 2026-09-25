import { env } from "@/lib/config/env";
import { numParam } from "@/lib/strategy/common";

export function objectParams(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? { ...(raw as Record<string, unknown>) }
    : {};
}

export function edgeBandFromParams(
  parameters: unknown,
  fallbackMin = env.EDGE_MIN,
  fallbackMax = env.EDGE_MAX,
): { minNetEdge: number; maxNetEdge: number } {
  const params = objectParams(parameters);
  const minNetEdge = numParam(params, "minNetEdge", fallbackMin);
  const maxNetEdge = numParam(params, "maxNetEdge", fallbackMax);
  return { minNetEdge, maxNetEdge };
}

export function netEdgeToPct(netEdge: number): number {
  return Math.round(netEdge * 10_000) / 100;
}

/** Dashboard sends percent (8 = 8%). Values in (0, 1] are treated as already-normalized. */
export function parseEdgePct(raw: unknown): number | null {
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(value)) return null;
  const net = value > 1 ? value / 100 : value;
  if (net < 0 || net > 1) return null;
  return net;
}

export function mergeEdgeBand(
  parameters: unknown,
  patch: { minNetEdge?: number; maxNetEdge?: number },
): Record<string, unknown> {
  const next = objectParams(parameters);
  if (patch.minNetEdge != null) next.minNetEdge = patch.minNetEdge;
  if (patch.maxNetEdge != null) next.maxNetEdge = patch.maxNetEdge;
  const min = numParam(next, "minNetEdge", env.EDGE_MIN);
  const max = numParam(next, "maxNetEdge", env.EDGE_MAX);
  if (min > max) next.maxNetEdge = min;
  return next;
}
