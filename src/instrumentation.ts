export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { readRecordControl } = await import("@/lib/record/control");
  const { ensureRecordWorker } = await import("@/lib/record/supervisor");
  const control = await readRecordControl();
  if (control.desired !== "running") return;
  await ensureRecordWorker();
}
