/** Plans, and the limits each one buys.
 *
 *  `skus` is the ceiling on a single catalogue audit. It is a real cost
 *  control, not a paywall gesture: classification runs ~175 ms of CPU per
 *  item, so an unbounded catalogue is a denial-of-service against ourselves.
 */
export type PlanId = "free" | "starter" | "growth" | "pro";

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
      "Full duty stack with authorities",
      "All 19,949 code pages",
      "Cited CBP rulings",
    ],
  },
  starter: {
    id: "starter", name: "Starter", priceMonthly: 99, blurb: "one buyer, one catalogue",
    skus: 100, seats: 1, monitoring: true, savings: false, binder: false, api: false,
    features: [
      "100 SKUs monitored",
      "Email alerts when a tariff action hits your codes",
      "Saved catalogues",
      "CSV export",
    ],
  },
  growth: {
    id: "growth", name: "Growth", priceMonthly: 499, blurb: "$100k–$1M duty a year",
    skus: 1000, seats: 3, monitoring: true, savings: true, binder: true, api: false,
    features: [
      "1,000 SKUs monitored",
      "Savings analysis — FTA eligibility, alternate defensible codes",
      "Refundable-duty report (IEEPA)",
      "Classification binder export (PDF)",
      "3 seats",
    ],
  },
  pro: {
    id: "pro", name: "Pro", priceMonthly: 1999, blurb: "brokers and $1M+ duty",
    skus: 10000, seats: 100, monitoring: true, savings: true, binder: true, api: true,
    features: [
      "Unlimited SKUs",
      "Entry audit — upload CBP 7501s, compare declared against computed",
      "API access",
      "Multi-client workspaces",
      "Unlimited seats",
    ],
  },
};

export const PAID_PLANS: PlanId[] = ["starter", "growth", "pro"];

/** Stripe price ids, one per paid plan. */
export function priceIdFor(plan: PlanId): string | undefined {
  return {
    starter: process.env.STRIPE_PRICE_STARTER,
    growth: process.env.STRIPE_PRICE_GROWTH,
    pro: process.env.STRIPE_PRICE_PRO,
  }[plan as "starter" | "growth" | "pro"];
}

export function planForPriceId(priceId: string): PlanId | null {
  const map: Record<string, PlanId> = {};
  if (process.env.STRIPE_PRICE_STARTER) map[process.env.STRIPE_PRICE_STARTER] = "starter";
  if (process.env.STRIPE_PRICE_GROWTH) map[process.env.STRIPE_PRICE_GROWTH] = "growth";
  if (process.env.STRIPE_PRICE_PRO) map[process.env.STRIPE_PRICE_PRO] = "pro";
  return map[priceId] ?? null;
}
