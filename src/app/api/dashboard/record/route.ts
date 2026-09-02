import { NextRequest } from "next/server";
import { childLogger } from "@/lib/logger";
import { loadRecordPayload } from "@/lib/record/load";
import {
  startRecordSession,
  stopRecordSession,
} from "@/lib/record/control";
import { ensureRecordWorker, stopRecordWorker } from "@/lib/record/supervisor";

export const dynamic = "force-dynamic";

const log = childLogger({ component: "dashboard-record" });

export async function GET() {
  return Response.json(await loadRecordPayload());
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const action =
    body && typeof body === "object" && "action" in body ? String((body as { action: unknown }).action) : "";
  if (action !== "start" && action !== "stop") {
    return Response.json({ error: "action must be start or stop" }, { status: 400 });
  }

  try {
    if (action === "start") {
      await startRecordSession();
      const worker = await ensureRecordWorker();
      if (worker.error) {
        log.warn({ err: worker.error }, "record worker spawn failed");
      }
    } else {
      await stopRecordSession();
      await stopRecordWorker();
    }
  } catch (error) {
    log.warn({ err: String(error), action }, "record control failed");
    return Response.json({ error: "record control failed" }, { status: 503 });
  }

  return Response.json(await loadRecordPayload());
}
