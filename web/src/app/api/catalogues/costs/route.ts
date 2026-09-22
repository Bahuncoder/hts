import { currentViewer } from "@/lib/auth";
import { db } from "@/lib/store";
import { parseCosts } from "@/lib/landedCost";
import { sameOrigin } from "@/lib/requestOrigin";
import { readJson } from "@/lib/requestBody";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
  const viewer = await currentViewer();
  if (!viewer) return Response.json({ error: "Sign in first." }, { status: 401 });
  let id, costs;
  try {
    const body = await readJson(request, 4096) as Record<string, unknown>;
    id = body.id;
    if (typeof id !== "string" || id.length > 100) throw new Error("Invalid catalogue.");
    costs = parseCosts(body.costs);
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Enter valid costs." }, { status: 400 }); }
  const result = await (await db()).execute({ sql: "UPDATE catalogue SET landed_cost_json = ?, updated_at = ? WHERE id = ? AND account_id = ?", args: [JSON.stringify(costs), new Date().toISOString(), id, viewer.account.id] });
  return Response.json(result.rowsAffected ? { ok: true } : { error: "Catalogue not found." }, { status: result.rowsAffected ? 200 : 404 });
}
