import { NextRequest } from "next/server";
import { childLogger } from "@/lib/logger";
import { loadDashboard } from "@/lib/dashboard/load";
import { closePaperPosition } from "@/lib/paper/close";

export const dynamic = "force-dynamic";

const log = childLogger({ component: "dashboard-positions" });

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const id =
    body && typeof body === "object" && "id" in body ? String((body as { id: unknown }).id) : "";
  if (!id) {
    return Response.json({ error: "id is required" }, { status: 400 });
  }

  try {
    const result = await closePaperPosition(id);
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
