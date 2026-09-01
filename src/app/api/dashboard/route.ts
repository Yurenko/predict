import { loadDashboard } from "@/lib/dashboard/load";

export const dynamic = "force-dynamic";

export async function GET() {
  const payload = await loadDashboard();
  return Response.json(payload);
}
