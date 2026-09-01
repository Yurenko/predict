import { NextRequest } from "next/server";
import { prometheusText, snapshotMetrics } from "@/lib/observability/metrics";
import { assertNoSecrets } from "@/lib/dashboard/sanitize";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const snapshot = snapshotMetrics();
  assertNoSecrets(snapshot);
  const format = request.nextUrl.searchParams.get("format");
  if (format === "prom" || request.headers.get("accept")?.includes("text/plain")) {
    return new Response(prometheusText(snapshot), {
      headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
    });
  }
  return Response.json(snapshot);
}
