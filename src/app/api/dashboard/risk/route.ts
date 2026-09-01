import { NextRequest } from "next/server";
import { RiskEventType, SystemEventLevel } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { childLogger } from "@/lib/logger";
import { loadRiskState, persistRiskSnapshot } from "@/lib/risk/persist";
import { loadDashboard } from "@/lib/dashboard/load";

export const dynamic = "force-dynamic";

const log = childLogger({ component: "dashboard-risk" });

export async function PATCH(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || !("killSwitch" in body)) {
    return Response.json({ error: "killSwitch is required" }, { status: 400 });
  }
  if ("LIVE_TRADING_ENABLED" in body || "TRADING_MODE" in body) {
    return Response.json({ error: "live flags cannot be changed from the dashboard" }, { status: 400 });
  }
  const killSwitch = Boolean((body as { killSwitch: unknown }).killSwitch);

  try {
    const state = await loadRiskState();
    const next = {
      ...state,
      killSwitch,
      killSwitchReason: killSwitch ? "manual_dashboard" : null,
    };
    await persistRiskSnapshot(next);
    await prisma.riskEvent.create({
      data: {
        type: RiskEventType.KILL_SWITCH,
        severity: killSwitch ? SystemEventLevel.ERROR : SystemEventLevel.INFO,
        message: killSwitch ? "kill switch armed from dashboard" : "kill switch cleared from dashboard",
      },
    });
  } catch (error) {
    log.warn({ err: String(error) }, "kill switch update failed");
    return Response.json({ error: "database down" }, { status: 503 });
  }

  return Response.json(await loadDashboard());
}
