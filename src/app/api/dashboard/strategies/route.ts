import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { childLogger } from "@/lib/logger";
import { loadDashboard } from "@/lib/dashboard/load";
import { mergeEdgeBand, parseEdgePct } from "@/lib/strategy/edge-params";

export const dynamic = "force-dynamic";

const log = childLogger({ component: "dashboard-strategy" });

export async function PATCH(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const slug = typeof record.slug === "string" ? record.slug : "";
  const hasEnabled = "enabled" in record;
  const hasEdge = "minEdgePct" in record || "maxEdgePct" in record;
  if (!slug || (!hasEnabled && !hasEdge)) {
    return Response.json({ error: "slug and enabled or edge percents are required" }, { status: 400 });
  }

  const minNetEdge = "minEdgePct" in record ? parseEdgePct(record.minEdgePct) : undefined;
  const maxNetEdge = "maxEdgePct" in record ? parseEdgePct(record.maxEdgePct) : undefined;
  if (hasEdge) {
    if ("minEdgePct" in record && minNetEdge == null) {
      return Response.json({ error: "minEdgePct must be 0–100" }, { status: 400 });
    }
    if ("maxEdgePct" in record && maxNetEdge == null) {
      return Response.json({ error: "maxEdgePct must be 0–100" }, { status: 400 });
    }
  }

  try {
    const current = await prisma.strategy.findUnique({ where: { slug } });
    if (!current) {
      return Response.json({ error: "strategy not found or database down" }, { status: 404 });
    }
    const data: { enabled?: boolean; parameters?: Prisma.InputJsonValue } = {};
    if (hasEnabled) data.enabled = Boolean(record.enabled);
    if (hasEdge) {
      data.parameters = mergeEdgeBand(current.parameters, {
        minNetEdge: minNetEdge ?? undefined,
        maxNetEdge: maxNetEdge ?? undefined,
      }) as Prisma.InputJsonValue;
    }
    await prisma.strategy.update({ where: { slug }, data });
  } catch (error) {
    log.warn({ err: String(error), slug }, "strategy update failed");
    return Response.json({ error: "strategy not found or database down" }, { status: 404 });
  }

  return Response.json(await loadDashboard());
}
