import { NextRequest } from "next/server";
import { TradingMode } from "@prisma/client";
import { childLogger } from "@/lib/logger";
import { prisma } from "@/lib/db/prisma";
import { loadDashboard } from "@/lib/dashboard/load";
import { closeLivePosition } from "@/lib/live/close";
import { syncLivePositionsFromVenue } from "@/lib/live/venue-sync";
import { closePaperPosition } from "@/lib/paper/close";
import { ensureLiveRuntime } from "@/lib/record/live-runtime";

export const dynamic = "force-dynamic";

const log = childLogger({ component: "dashboard-positions" });

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const claimAll =
    body && typeof body === "object" && "action" in body
      ? (body as { action?: unknown }).action === "claim"
      : false;
  if (claimAll) {
    try {
      const runtime = await ensureLiveRuntime();
      if (!runtime.ok) {
        return Response.json({ error: runtime.skip || "no_runtime" }, { status: 400 });
      }
      const result = await syncLivePositionsFromVenue(runtime.venue, runtime.ctx, {
        immediate: true,
      });
      log.info(result, "manual claim all");
      return Response.json({ ...(await loadDashboard()), claimed: result.claimed });
    } catch (error) {
      log.warn({ err: String(error) }, "manual claim all failed");
      return Response.json({ error: "claim failed" }, { status: 503 });
    }
  }

  const id =
    body && typeof body === "object" && "id" in body ? String((body as { id: unknown }).id) : "";
  if (!id) {
    return Response.json({ error: "id is required" }, { status: 400 });
  }

  try {
    const row = await prisma.position.findUnique({ where: { id }, select: { mode: true } });
    if (!row) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const result =
      row.mode === TradingMode.LIVE ? await closeLivePosition(id) : await closePaperPosition(id);
    if (!result.ok) {
      const status =
        result.reason === "not_found" ? 404 : result.reason === "not_open" ? 409 : 400;
      return Response.json({ error: result.reason }, { status });
    }
  } catch (error) {
    log.warn({ err: String(error), id }, "manual close failed");
    return Response.json({ error: "close failed" }, { status: 503 });
  }

  return Response.json(await loadDashboard());
}
