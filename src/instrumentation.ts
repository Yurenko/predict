import { childLogger } from "@/lib/logger";
import { inc } from "@/lib/observability/metrics";
import { recordSystemEvent } from "@/lib/observability/events";
import { CURRENT_PHASE } from "@/lib/types/domain";
import { SystemEventLevel } from "@prisma/client";

export async function register(): Promise<void> {
  childLogger({ component: "next" }).info({ phase: CURRENT_PHASE }, "instrumentation registered");
}

export async function onRequestError(
  error: unknown,
  request: { path: string; method: string },
): Promise<void> {
  inc("http.request_error", { method: request.method });
  const message = error instanceof Error ? error.message : String(error);
  await recordSystemEvent({
    level: SystemEventLevel.ERROR,
    component: "next",
    message,
    details: { path: request.path, method: request.method },
  });
}
