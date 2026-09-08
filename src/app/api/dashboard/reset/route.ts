import { NextRequest } from "next/server";
import { childLogger } from "@/lib/logger";
import { loadDashboard } from "@/lib/dashboard/load";
import { resetDashboardData, type ResetScope } from "@/lib/dashboard/reset";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const log = childLogger({ component: "dashboard-reset-api" });

const SCOPES = new Set<ResetScope>(["paper", "record", "all"]);

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const scope =
    body && typeof body === "object" && "scope" in body
      ? String((body as { scope: unknown }).scope)
      : "";
  if (!SCOPES.has(scope as ResetScope)) {
    return Response.json({ error: "scope must be paper, record, or all" }, { status: 400 });
  }

  try {
    await resetDashboardData(scope as ResetScope);
  } catch (error) {
    const code = error instanceof Error ? error.message : "reset failed";
    log.warn({ err: String(error), scope }, "dashboard reset failed");
    if (code === "stop_first") {
      return Response.json({ error: "stop_first" }, { status: 409 });
    }
    return Response.json({ error: "reset failed" }, { status: 503 });
  }

  try {
    return Response.json(await loadDashboard());
  } catch (error) {
    log.warn({ err: String(error), scope }, "dashboard reload after reset failed");
    return Response.json({ ok: true, scope });
  }
}
