import { piIsHealthy } from "@/lib/pi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const healthy = await piIsHealthy();
  return Response.json({ status: healthy ? "healthy" : "degraded" }, {
    status: healthy ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
