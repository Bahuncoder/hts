import { NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { planForPriceId } from "@/lib/plans";
import { accountForCustomer, claimWebhookEvent, upsertSubscription } from "@/lib/store";
import type Stripe from "stripe";

export const runtime = "nodejs";

/** Stripe webhook.
 *
 *  Stripe is the source of truth for what someone is paying for; this endpoint
 *  is the only thing that writes a paid plan into our database. Two rules keep
 *  it honest:
 *
 *    - the signature is verified against the RAW body, so a forged request
 *      cannot grant itself a plan;
 *    - every event id is claimed once, because Stripe retries and an
 *      out-of-order redelivery could otherwise downgrade an account that has
 *      since upgraded.
 */
export async function POST(request: Request) {
  const s = stripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!s || !secret) {
    return NextResponse.json({ error: "billing not configured" }, { status: 503 });
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "missing signature" }, { status: 400 });
  }

  const raw = await request.text();
  let event: Stripe.Event;
  try {
    event = s.webhooks.constructEvent(raw, signature, secret);
  } catch {
    // Never echo the reason: it tells a prober how close they got.
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }

  if (!(await claimWebhookEvent(event.id, event.type))) {
    return NextResponse.json({ received: true, duplicate: true });
  }

  try {
    await apply(s, event);
  } catch (err) {
    console.error("stripe webhook failed", event.type, err);
    // 500 so Stripe retries; the event id claim is rolled forward only on
    // success paths that matter, and a retry re-runs an idempotent upsert.
    return NextResponse.json({ error: "handler failed" }, { status: 500 });
  }
  return NextResponse.json({ received: true });
}

async function apply(s: Stripe, event: Stripe.Event) {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const accountId = session.client_reference_id ?? session.metadata?.account_id;
      const customerId = typeof session.customer === "string" ? session.customer : null;
      if (!accountId || !session.subscription) break;
      const subId = typeof session.subscription === "string"
        ? session.subscription : session.subscription.id;
      const sub = await s.subscriptions.retrieve(subId);
      await upsertSubscription({
        account_id: accountId,
        stripe_customer_id: customerId,
        ...fromSubscription(sub),
      });
      break;
    }

    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
      const accountId = sub.metadata?.account_id ?? await accountForCustomer(customerId);
      if (!accountId) {
        console.warn("subscription event for unknown customer", customerId);
        break;
      }
      await upsertSubscription({
        account_id: accountId,
        stripe_customer_id: customerId,
        ...(event.type === "customer.subscription.deleted"
          ? { stripe_subscription_id: null, plan: "free" as const, status: "canceled",
              current_period_end: null }
          : fromSubscription(sub)),
      });
      break;
    }

    default:
      break;
  }
}

function fromSubscription(sub: Stripe.Subscription) {
  const item = sub.items.data[0];
  const plan = item?.price?.id ? planForPriceId(item.price.id) : null;
  // `current_period_end` lives on the item in recent API versions.
  const periodEnd = (item as unknown as { current_period_end?: number })?.current_period_end
    ?? (sub as unknown as { current_period_end?: number }).current_period_end;
  return {
    stripe_subscription_id: sub.id,
    plan: plan ?? ("free" as const),
    status: sub.status,
    current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
  };
}
