/** Plans, and the limits each one buys.
 *
 *  `skus` is the ceiling on a single catalogue audit. It is a real cost
 *  control, not a paywall gesture: classification runs ~175 ms of CPU per
 *  item, so an unbounded catalogue is a denial-of-service against ourselves.
 */
export type PlanId = "free" | "starter" | "growth";

/** Only what is built ships as a plan feature. Anything on the roadmap is
 *  listed separately and labelled, so nobody buys a tier for something that
 *  does not exist yet. */
export const IN_BUILD = [
  "Savings analysis — FTA eligibility and alternate defensible codes",
  "Classification binder export for your reasonable-care file",
  "Team seats and shared catalogues",
  "Re-price a saved catalogue and compare it with the last run",
  "Entry audit — upload CBP 7501s and compare declared against computed",
  "API access",
] as const;

export type Plan = {
  id: PlanId;
  name: string;
  priceMonthly: number;
  blurb: string;
  skus: number;
  seats: number;
  monitoring: boolean;
  savings: boolean;
  binder: boolean;
  api: boolean;
  features: string[];
};

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free", name: "Free", priceMonthly: 0, blurb: "no card",
    skus: 25, seats: 1, monitoring: false, savings: false, binder: false, api: false,
    features: [
      "25 products per audit",
      "Full duty stack with the authority for every line",
      "All 19,949 code pages and their CBP rulings",
      "IEEPA scenario estimate where it reaches a code (not a claim amount)",
    ],
  },
  starter: {
    id: "starter", name: "Starter", priceMonthly: 99, blurb: "one buyer, one catalogue",
    skus: 100, seats: 1, monitoring: true, savings: false, binder: false, api: false,
    features: [
      "100 products, saved and monitored",
      "Email when a tariff action names one of your codes",
      "CSV export",
    ],
  },
  growth: {
    id: "growth", name: "Growth", priceMonthly: 499, blurb: "a full catalogue",
    skus: 1000, seats: 1, monitoring: true, savings: false, binder: false, api: false,
    features: [
      "1,000 products, saved and monitored",
      "Everything in Starter",
    ],
  },
};

export const PAID_PLANS: PlanId[] = ["starter", "growth"];

/** Stripe price ids, one per paid plan. */
export function priceIdFor(plan: PlanId): string | undefined {
  return {
    starter: process.env.STRIPE_PRICE_STARTER,
    growth: process.env.STRIPE_PRICE_GROWTH,
  }[plan as "starter" | "growth"];
}

export function planForPriceId(priceId: string): PlanId | null {
  const map: Record<string, PlanId> = {};
  if (process.env.STRIPE_PRICE_STARTER) map[process.env.STRIPE_PRICE_STARTER] = "starter";
  if (process.env.STRIPE_PRICE_GROWTH) map[process.env.STRIPE_PRICE_GROWTH] = "growth";
  return map[priceId] ?? null;
}
