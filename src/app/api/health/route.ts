import { collectHealth } from "@/lib/observability/health";

export const dynamic = "force-dynamic";

export async function GET() {
  const health = await collectHealth();
  return Response.json(health);
}
