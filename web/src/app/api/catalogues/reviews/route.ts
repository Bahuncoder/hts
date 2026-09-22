import { currentViewer } from "@/lib/auth";
import { recordReview, ReviewValidationError, type ReviewAction } from "@/lib/reviews";
import { sameOrigin } from "@/lib/requestOrigin";
import { readJson } from "@/lib/requestBody";
export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
  const viewer = await currentViewer();
  if (!viewer) return Response.json({ error: "Sign in first." }, { status: 401 });
  let input;
  try {
    const body = await readJson(request, 12000) as Record<string, unknown>;
    if (!body || typeof body.catalogueId !== "string" || typeof body.itemId !== "string" || body.catalogueId.length > 100 || body.itemId.length > 100) throw new Error();
    input = { catalogueId: body.catalogueId, itemId: body.itemId, action: body.action as ReviewAction, note: body.note as string, version: body.version as number };
    const saved = await recordReview(viewer.account.id, viewer.account.email, input);
    return Response.json(saved ? { ok: true } : { error: "Review not saved. Reload to get the latest state. Failed or incomplete lines cannot be approved; a catalogue can hold up to 1,000 review events." }, { status: saved ? 200 : 409 });
  } catch (error) {
    if (error instanceof ReviewValidationError) return Response.json({ error: error.message }, { status: 400 });
    return Response.json({ error: "Unable to record this review. Check the input and try again." }, { status: 400 });
  }
}
