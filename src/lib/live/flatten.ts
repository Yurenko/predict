/** LIVE EXIT keeps selling leftover shares until CLOSED — paper fills 100% in one tick. */
export function isLiveFlattening(raw: unknown): boolean {
  return Boolean(
    raw &&
      typeof raw === "object" &&
      !Array.isArray(raw) &&
      (raw as { liveFlatten?: unknown }).liveFlatten === true,
  );
}

export function stampLiveFlatten(raw: unknown): Record<string, unknown> {
  const base =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? { ...(raw as Record<string, unknown>) }
      : {};
  return { ...base, liveFlatten: true };
}

export function clearLiveFlatten(raw: unknown): Record<string, unknown> {
  const base =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? { ...(raw as Record<string, unknown>) }
      : {};
  delete base.liveFlatten;
  return base;
}
