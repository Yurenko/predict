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
    log.warn({ err: String(error), scope }, "dashboard reset failed");
    return Response.json({ error: "reset failed" }, { status: 503 });
  }

  return Response.json(await loadDashboard());
}
