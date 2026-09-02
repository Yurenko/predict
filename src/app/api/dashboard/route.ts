import type { NextRequest } from "next/server";
import { loadDashboard } from "@/lib/dashboard/load";
import { parseLedgerPage, parseLedgerPageSize } from "@/lib/dashboard/pages";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams;
  const payload = await loadDashboard({
    positionsPage: parseLedgerPage(query.get("positionsPage")),
    ordersPage: parseLedgerPage(query.get("ordersPage")),
    signalsPage: parseLedgerPage(query.get("signalsPage")),
    pageSize: parseLedgerPageSize(query.get("pageSize")),
  });
  return Response.json(payload);
}
