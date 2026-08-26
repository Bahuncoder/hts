import Stripe from "stripe";

let _stripe: Stripe | null = null;

/** Returns null when no key is configured, so the app runs — and the pricing
 *  page renders — before billing is switched on. */
export function stripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  if (!_stripe) _stripe = new Stripe(key, { apiVersion: "2026-07-29.dahlia" });
  return _stripe;
}

export function billingEnabled(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

export function siteUrl(): string {
  return process.env.SITE_URL ?? "http://localhost:3000";
}
