"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { REVIEW_ACTIONS, MAX_REVIEW_NOTE, type ReviewAction, type ReviewEvent } from "@/lib/reviewModel";
import type { CatalogueItem } from "@/lib/catalogues";
import EvidenceSnapshot from "./EvidenceSnapshot";
export default function ReviewWorkspace({ catalogueId, items, history }: { catalogueId: string; items: CatalogueItem[]; history: ReviewEvent[] }) {
  const [selected, setSelected] = useState(items[0]?.id ?? "");
  const [action, setAction] = useState<ReviewAction>("comment");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const router = useRouter();
  const item = items.find((i) => i.id === selected);
  if (!item) return null;
  return <section className="paper-card space-y-4 p-5" aria-label="Classification review">
    <h2 className="serif text-2xl">Evidence and classification review</h2>
    <Link href={`/catalogues/${catalogueId}/review`} className="text-accent underline">Open detailed review and assignments</Link>
    <p className="text-sm text-muted">Your decision is recorded separately from the engine result. Approval does not erase calculation warnings or change duty estimates.</p>
    <label>Product line<select aria-label="Product line" className="field-control w-full" value={selected} onChange={(e) => { setSelected(e.target.value); setNote(""); setMessage(""); }}>{items.map((i) => <option key={i.id} value={i.id}>{i.row_number ?? "—"}. {i.sku || i.description.slice(0, 100)} — {i.review_status.replaceAll("_", " ")}</option>)}</select></label>
    <EvidenceSnapshot json={item.evidence_json} />
    <p>Review status: <strong>{item.review_status.replaceAll("_", " ")}</strong></p>
    <form className="space-y-3" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setMessage("");
      try {
        const response = await fetch("/api/catalogues/reviews", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ catalogueId, itemId: item.id, version: item.review_version, action, note }) });
        const result = await response.json();
        setMessage(response.ok ? "Review recorded." : result.error);
        if (response.ok) setNote("");
        router.refresh();
      } catch { setMessage("Could not record review. Try again."); }
      finally { setBusy(false); }
    }}>
      <label>Review action<select aria-label="Review action" className="field-control w-full" value={action} onChange={(e) => setAction(e.target.value as ReviewAction)}>{REVIEW_ACTIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}</select></label>
      <label>Reason or comment<textarea className="field-control w-full" required maxLength={MAX_REVIEW_NOTE} value={note} onChange={(e) => setNote(e.target.value)} /></label>
      <button className="btn btn-primary" disabled={busy}>{busy ? "Recording…" : "Record review"}</button><p role="status">{message}</p>
    </form>
    <h3 className="font-semibold">Review history</h3>
    <ol className="space-y-3">{history.filter((event) => event.item_id === item.id).map((event) => <li key={event.id} className="border-t border-rule pt-2"><p>{event.actor_email} · {event.at} · {event.action.replaceAll("_", " ")}</p>{event.action === "assignment" && <p>Assigned to: {event.assigned_to || "Unassigned"}</p>}<p className="whitespace-pre-wrap">{event.note}</p></li>)}</ol>
    {!history.some((event) => event.item_id === item.id) && <p>No decisions recorded for this line.</p>}
  </section>;
}
