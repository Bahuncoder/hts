/** Bounded, immutable snapshot of the evidence used by the classifier. It is
 * projected before signing and again before verification; no browser evidence
 * can be persisted unless it matches the signed calculation. */
export type RulingSnapshot = { ruling: string; subject: string; date: string; revoked: boolean; url: string | null; excerpt: string };
export type EvidenceSnapshot = { source: "classifier" | "no_classifier_evidence"; candidate_hts: string; description: string; reasoning: string; rulings: RulingSnapshot[] };
const text = (v: unknown, max: number) => typeof v === "string" ? v.slice(0, max) : "";
export function rulingUrl(value: unknown): string | null {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" && url.hostname === "rulings.cbp.gov" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
export function projectEvidence(value: unknown): EvidenceSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const rulings = Array.isArray(raw.rulings) ? raw.rulings.slice(0, 5) : [];
  return {
    source: raw.source === "no_classifier_evidence" ? "no_classifier_evidence" : "classifier",
    candidate_hts: text(raw.candidate_hts ?? raw.hts, 40),
    description: text(raw.description, 1000), reasoning: text(raw.reasoning, 2000),
    rulings: rulings.filter((r) => r && typeof r === "object").map((r) => ({
      ruling: text(r.ruling, 100), subject: text(r.subject, 500), date: text(r.date, 40),
      revoked: r.revoked === true, url: rulingUrl(r.url), excerpt: text(r.excerpt, 900),
    })),
  };
}
