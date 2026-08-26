import { NextResponse } from "next/server";
import { currentViewer } from "@/lib/auth";
import { PAID_PLANS, priceIdFor, type PlanId } from "@/lib/plans";
import { siteUrl, stripe } from "@/lib/stripe";
import { subscriptionFor, upsertSubscription } from "@/lib/store";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const viewer = await currentViewer();
  if (!viewer) return NextResponse.json({ error: "sign in first" }, { status: 401 });

  const s = stripe();
  if (!s) return NextResponse.json({ error: "billing not configured" }, { status: 503 });

  const { plan } = (await request.json().catch(() => ({}))) as { plan?: PlanId };
  if (!plan || !PAID_PLANS.includes(plan)) {
    return NextResponse.json({ error: "unknown plan" }, { status: 400 });
  }
  const price = priceIdFor(plan);
  if (!price) {
    return NextResponse.json({ error: `no price configured for ${plan}` }, { status: 503 });
  }

  // Reuse the customer so a second subscription does not orphan the first.
  const existing = subscriptionFor(viewer.account.id);
  let customerId = existing.stripe_customer_id;
  if (!customerId) {
    const customer = await s.customers.create({
      email: viewer.account.email,
      metadata: { account_id: viewer.account.id },
    });
    customerId = customer.id;
    upsertSubscription({ account_id: viewer.account.id, stripe_customer_id: customerId,
                         plan: existing.plan, status: existing.status });
  }

  const session = await s.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    client_reference_id: viewer.account.id,
    line_items: [{ price, quantity: 1 }],
    subscription_data: { metadata: { account_id: viewer.account.id } },
    success_url: `${siteUrl()}/account?checkout=done`,
    cancel_url: `${siteUrl()}/pricing?checkout=cancelled`,
    allow_promotion_codes: true,
  });

  return NextResponse.json({ url: session.url });
}
