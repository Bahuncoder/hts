import Stripe from "stripe";

let _stripe: Stripe | null = null;

/** Returns null when no key is configured, so the app runs — and the pricing
 *  page renders — before billing is switched on. */
export function stripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  if (!_stripe) {
    // Lets an integration test point the SDK at a local fake; unset in production.
    const host = process.env.STRIPE_API_HOST;
    _stripe = new Stripe(key, {
      apiVersion: "2026-07-29.dahlia",
      ...(host ? {
        host,
        port: process.env.STRIPE_API_PORT,
        protocol: process.env.STRIPE_API_PROTOCOL === "https" ? "https" : "http",
      } : {}),
    });
  }
  return _stripe;
}

export function billingEnabled(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

export function siteUrl(): string {
  return process.env.SITE_URL ?? "http://localhost:3000";
}
