import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { childLogger } from "@/lib/logger";
import { loadDashboard } from "@/lib/dashboard/load";
import { parsePaperEntryMode, writePaperEntryMode } from "@/lib/paper/entry-mode";

export const dynamic = "force-dynamic";

const log = childLogger({ component: "dashboard-strategy" });

export async function PATCH(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  const entryMode =
    body && typeof body === "object" && "entryMode" in body
      ? parsePaperEntryMode((body as { entryMode: unknown }).entryMode)
      : null;
  if (entryMode) {
    try {
      await writePaperEntryMode(entryMode);
    } catch (error) {
      log.warn({ err: String(error), entryMode }, "paper entry mode write failed");
      return Response.json({ error: "could not save entry mode" }, { status: 503 });
    }
    return Response.json(await loadDashboard());
  }

  const slug = typeof body === "object" && body && "slug" in body ? String(body.slug) : "";
  const enabled =
    typeof body === "object" && body && "enabled" in body ? Boolean(body.enabled) : null;
  if (!slug || enabled === null) {
    return Response.json({ error: "slug and enabled, or entryMode, are required" }, { status: 400 });
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
