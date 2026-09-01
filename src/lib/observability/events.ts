import { Prisma, SystemEventLevel } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { childLogger } from "@/lib/logger";
import { inc } from "@/lib/observability/metrics";

const log = childLogger({ component: "system-event" });

export async function recordSystemEvent(event: {
  level: SystemEventLevel;
  component: string;
  message: string;
  correlationId?: string;
  strategyId?: string;
  marketId?: string;
  orderId?: string;
  details?: Record<string, unknown>;
}): Promise<void> {
  inc("system.event", { level: event.level, component: event.component });
  log[event.level === "ERROR" ? "error" : event.level === "WARN" ? "warn" : "info"](
    {
      component: event.component,
      correlationId: event.correlationId,
      strategyId: event.strategyId,
      marketId: event.marketId,
      orderId: event.orderId,
    },
    event.message,
  );
  try {
    await prisma.systemEvent.create({
      data: {
        level: event.level,
        component: event.component,
        message: event.message,
        correlationId: event.correlationId,
        strategyId: event.strategyId,
        marketId: event.marketId,
        orderId: event.orderId,
        details: (event.details ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  } catch (error) {
    log.warn({ err: String(error) }, "system event persist skipped");
  }
}
