import { projectEvidence } from "@/lib/evidence";
export default function EvidenceSnapshot({ json }: { json: string | null }) {
  const evidence = json ? projectEvidence(JSON.parse(json)) : undefined;
  if (!evidence) return <p className="text-sm text-muted">Legacy record: ruling evidence was not captured. Run a new audit to retain available evidence.</p>;
  if (evidence.source === "no_classifier_evidence") return <p className="text-sm text-muted">No classifier ruling evidence was used for this line (for example, a supplied HTS code).</p>;
  return <div className="space-y-2 text-sm">
    <p>Classifier candidate: {evidence.candidate_hts} — {evidence.description}</p>
    {evidence.reasoning && <p>{evidence.reasoning}</p>}
    {!evidence.rulings.length && <p>No supporting rulings were returned for this candidate.</p>}
    {evidence.rulings.map((r, i) => <section key={i} className="border-l border-rule pl-3 break-inside-avoid">
      <p className="font-semibold">{r.url ? <a href={r.url} target="_blank" rel="noopener noreferrer" className="underline">{r.ruling}</a> : r.ruling} · {r.date || "Date not recorded"}{r.revoked ? " · REVOKED" : ""}</p>
      <p>{r.subject}</p>{r.excerpt && <blockquote>{r.excerpt}</blockquote>}
    </section>)}
    <p className="text-xs text-muted">Evidence snapshot from the saved calculation; excerpts are not the full ruling. Revocation status is as recorded at that time.</p>
  </div>;
}
