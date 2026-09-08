import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { childLogger } from "@/lib/logger";
import { loadDashboard } from "@/lib/dashboard/load";

export const dynamic = "force-dynamic";

const log = childLogger({ component: "dashboard-strategy" });

export async function PATCH(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  const slug = typeof body === "object" && body && "slug" in body ? String(body.slug) : "";
  const enabled =
    typeof body === "object" && body && "enabled" in body ? Boolean(body.enabled) : null;
  if (!slug || enabled === null) {
    return Response.json({ error: "slug and enabled are required" }, { status: 400 });
  }

  try {
    await prisma.strategy.update({
      where: { slug },
      data: { enabled },
    });
  } catch (error) {
    log.warn({ err: String(error), slug }, "strategy toggle failed");
    return Response.json({ error: "strategy not found or database down" }, { status: 404 });
  }

  return Response.json(await loadDashboard());
}
