/** Usage limits: the single source of truth.
 *
 *  HTSDesk is free. There are two audiences, an anonymous visitor and a
 *  signed-in account, and every limit below is a real cost control rather
 *  than a paywall gesture: classification runs ~175 ms of CPU per item, so an
 *  unbounded catalogue, or one heavy user, is a denial-of-service against
 *  everyone else.
 *
 *  Every number lives here. The audit proxy (api/audit), the work budget
 *  (lib/budget.ts), the save path (lib/actions.ts, lib/catalogues.ts) and the
 *  pages that state these limits all read from this file, so what a page
 *  promises is what the server enforces. Limits may change during the beta.
 */
export type Tier = "anonymous" | "account";
export const MAX_STANDALONE_WATCHES = 200;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export type Window = { max: number; windowMs: number };

export type Limits = {
  /** Products in one audit request. */
  productsPerAudit: number;
  /** How often an audit may be started. */
  auditRequests: Window;
  /** Products audited in total over a rolling 24 hours. */
  itemsPerDay: Window;
  /** Saved catalogues. Only accounts can save; 0 for an anonymous visitor. */
  savedCatalogues: number;
};

export const LIMITS: Record<Tier, Limits> = {
  anonymous: {
    productsPerAudit: 25,
    auditRequests: { max: 3, windowMs: 10 * MINUTE },
    itemsPerDay: { max: 150, windowMs: DAY },
    savedCatalogues: 0,
  },
  account: {
    productsPerAudit: 200,
    auditRequests: { max: 10, windowMs: HOUR },
    itemsPerDay: { max: 2000, windowMs: DAY },
    savedCatalogues: 20,
  },
};

/** Roadmap: not built yet. Listed separately so nothing on a page implies it
 *  exists. */
export const IN_BUILD = [
  "Savings analysis — FTA eligibility and alternate defensible codes",
  "Classification binder export for your reasonable-care file",
  "Team seats and shared catalogues",
  "Re-price a saved catalogue and compare it with the last run",
  "Entry audit — upload CBP 7501s and compare declared against computed",
  "API access",
] as const;

/** "10 minutes", "hour", "day" for how a window reads in a sentence. */
export function windowLabel(windowMs: number): string {
  if (windowMs >= DAY) return "day";
  if (windowMs >= HOUR) return "hour";
  return `${Math.round(windowMs / MINUTE)} minutes`;
}
