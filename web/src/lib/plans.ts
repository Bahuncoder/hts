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

/** Paid plans, on top of the free/`account` baseline above. `Tier` (anonymous
 *  vs. account) is a separate, unrelated axis -- whether a caller is signed
 *  in at all -- and stays exactly as it is; `PlanId` only ever varies the
 *  ceiling a signed-in account gets. */
export type PlanId = "free" | "starter" | "growth";

/** `free` is `LIMITS.account` itself, not a duplicate literal: relaunch must
 *  not change anything for an existing free account, and there must only ever
 *  be one place that states the free numbers. */
export const PLAN_LIMITS: Record<PlanId, Limits> = {
  free: LIMITS.account,
  starter: {
    productsPerAudit: 500,
    auditRequests: { max: 20, windowMs: HOUR },
    itemsPerDay: { max: 5_000, windowMs: DAY },
    savedCatalogues: 75,
  },
  growth: {
    productsPerAudit: 2_000,
    auditRequests: { max: 60, windowMs: HOUR },
    itemsPerDay: { max: 25_000, windowMs: DAY },
    savedCatalogues: 500,
  },
};

/** Proposed starting prices -- a business decision, not an engineering one;
 *  change freely, it is only ever read from here. */
export const PLAN_PRICE_MONTHLY: Record<PlanId, number> = {
  free: 0, starter: 99, growth: 499,
};
export const PAID_PLANS: readonly PlanId[] = ["starter", "growth"];

/** Display copy for the pricing page. Numbers below are derived from
 *  `PLAN_LIMITS`/`PLAN_PRICE_MONTHLY` rather than repeated, so a limit change
 *  cannot leave the page's own copy of the same number stale. */
export const PLAN_COPY: Record<PlanId, { name: string; blurb: string; features: string[] }> = {
  free: {
    name: "Free",
    blurb: "For a first catalogue, or a small, steady one.",
    features: [
      `${PLAN_LIMITS.free.productsPerAudit.toLocaleString()} products per audit`,
      `${PLAN_LIMITS.free.itemsPerDay.max.toLocaleString()} products a day`,
      `${PLAN_LIMITS.free.savedCatalogues.toLocaleString()} saved, monitored catalogues`,
      "Duty engine, classifier and evidence, in full",
    ],
  },
  starter: {
    name: "Starter",
    blurb: "For a growing catalogue that outran the free ceiling.",
    features: [
      `${PLAN_LIMITS.starter.productsPerAudit.toLocaleString()} products per audit`,
      `${PLAN_LIMITS.starter.itemsPerDay.max.toLocaleString()} products a day`,
      `${PLAN_LIMITS.starter.savedCatalogues.toLocaleString()} saved, monitored catalogues`,
      "Everything in Free",
    ],
  },
  growth: {
    name: "Growth",
    blurb: "For a full import program across many SKUs.",
    features: [
      `${PLAN_LIMITS.growth.productsPerAudit.toLocaleString()} products per audit`,
      `${PLAN_LIMITS.growth.itemsPerDay.max.toLocaleString()} products a day`,
      `${PLAN_LIMITS.growth.savedCatalogues.toLocaleString()} saved, monitored catalogues`,
      "Everything in Starter",
    ],
  },
};

/** The Stripe price id a paid plan checks out with, from its own env var
 *  (STRIPE_PRICE_STARTER / STRIPE_PRICE_GROWTH) rather than a literal, since
 *  a Stripe price id is an environment-specific (test vs. live) secret-ish
 *  value, not something to hardcode. */
export function priceIdFor(plan: PlanId): string | undefined {
  if (plan === "starter") return process.env.STRIPE_PRICE_STARTER;
  if (plan === "growth") return process.env.STRIPE_PRICE_GROWTH;
  return undefined;
}

export function planForPriceId(priceId: string): PlanId | null {
  for (const plan of PAID_PLANS) if (priceIdFor(plan) === priceId) return plan;
  return null;
}

/** Roadmap: not built yet. Listed separately so nothing on a page implies it
 *  exists. Re-pricing a saved catalogue shipped (lib/reprice.ts, `make
 *  test-reprice`) and was removed from this list accordingly -- it must not
 *  be listed as upcoming when a page already does it. */
export const IN_BUILD = [
  "Savings analysis — FTA eligibility and alternate defensible codes",
  "Classification binder export for your reasonable-care file",
  "Team seats and shared catalogues",
  "Entry audit — upload CBP 7501s and compare declared against computed",
  "API access",
] as const;

/** "10 minutes", "hour", "day" for how a window reads in a sentence. */
export function windowLabel(windowMs: number): string {
  if (windowMs >= DAY) return "day";
  if (windowMs >= HOUR) return "hour";
  return `${Math.round(windowMs / MINUTE)} minutes`;
}
