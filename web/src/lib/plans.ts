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

/** A plan's programmatic-API allowance. Disabled entirely for anonymous
 *  visitors and the free plan -- API access is a paid capability. Where
 *  enabled, `itemsPerDay` is deliberately HALF of the same plan's web
 *  `itemsPerDay`, not equal to it: API traffic gets its own lease and its own
 *  daily quota (a customer's automated integration must not be blocked by, or
 *  share its budget with, their own team's manual web usage), but leaving the
 *  ceilings equal would silently double an account's total worst-case engine
 *  exposure for the same subscription price. `requests` (a per-minute rate)
 *  is not halved -- it bounds burstiness, not aggregate daily engine cost.
 *  `maxKeys` exists for rotation (mint a new key, migrate, revoke the old one)
 *  as much as for running several integrations at once. */
export type ApiLimits = { enabled: boolean; requests: Window; itemsPerDay: Window; maxKeys: number };

const NO_API: ApiLimits = { enabled: false, requests: { max: 0, windowMs: MINUTE }, itemsPerDay: { max: 0, windowMs: DAY }, maxKeys: 0 };

export type Limits = {
  /** Products in one audit request. */
  productsPerAudit: number;
  /** How often an audit may be started. */
  auditRequests: Window;
  /** Products audited in total over a rolling 24 hours. */
  itemsPerDay: Window;
  /** Saved catalogues. Only accounts can save; 0 for an anonymous visitor. */
  savedCatalogues: number;
  /** Programmatic API access. Disabled for anonymous and the free plan. */
  api: ApiLimits;
};

export const LIMITS: Record<Tier, Limits> = {
  anonymous: {
    productsPerAudit: 25,
    auditRequests: { max: 3, windowMs: 10 * MINUTE },
    itemsPerDay: { max: 150, windowMs: DAY },
    savedCatalogues: 0,
    api: NO_API,
  },
  account: {
    productsPerAudit: 200,
    auditRequests: { max: 10, windowMs: HOUR },
    itemsPerDay: { max: 2000, windowMs: DAY },
    savedCatalogues: 20,
    api: NO_API,
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
    api: { enabled: true, requests: { max: 60, windowMs: MINUTE }, itemsPerDay: { max: 2_500, windowMs: DAY }, maxKeys: 3 },
  },
  growth: {
    // 1,000, not 2,000: the engine hard-rejects any audit request over 1,000
    // items outright (api/main.py's AuditRequest.items max_length), regardless
    // of caller. 2,000 promised a ceiling the engine could never actually
    // honor for a request between 1,001 and 2,000 items.
    productsPerAudit: 1_000,
    auditRequests: { max: 60, windowMs: HOUR },
    itemsPerDay: { max: 25_000, windowMs: DAY },
    savedCatalogues: 500,
    api: { enabled: true, requests: { max: 300, windowMs: MINUTE }, itemsPerDay: { max: 12_500, windowMs: DAY }, maxKeys: 10 },
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
      `API access — ${PLAN_LIMITS.starter.api.itemsPerDay.max.toLocaleString()} products a day`,
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
      `API access — ${PLAN_LIMITS.growth.api.itemsPerDay.max.toLocaleString()} products a day`,
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
 *  exists. Re-pricing a saved catalogue and API access (starter/growth,
 *  lib/apiKeys.ts, /account/api-keys) both shipped and were removed from this
 *  list accordingly -- neither must be listed as upcoming when a page already
 *  does it. */
export const IN_BUILD = [
  "Savings analysis — FTA eligibility and alternate defensible codes",
  "Classification binder export for your reasonable-care file",
  "Team seats and shared catalogues",
  "Entry audit — upload CBP 7501s and compare declared against computed",
] as const;

/** "10 minutes", "hour", "day" for how a window reads in a sentence. */
export function windowLabel(windowMs: number): string {
  if (windowMs >= DAY) return "day";
  if (windowMs >= HOUR) return "hour";
  return `${Math.round(windowMs / MINUTE)} minutes`;
}
