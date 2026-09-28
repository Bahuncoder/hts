import { NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { planForPriceId } from "@/lib/plans";
import {
  accountForCustomer, applySubscriptionState, claimWebhookEvent,
  clearSubscriptionIfCurrent, finishWebhookEvent,
} from "@/lib/store";
import type Stripe from "stripe";

export const runtime = "nodejs";

/** Stripe webhook.
 *
 *  Stripe is the source of truth for what someone is paying for; this endpoint
 *  is the only thing that writes a paid plan into our database. Three rules
 *  keep it honest:
 *
 *    - the signature is verified against the RAW body, so a forged request
 *      cannot grant itself a plan;
 *    - every event id has a durable state (processing, succeeded, failed).
 *      Only a succeeded id is acknowledged as a duplicate; a failed one is
 *      redone when Stripe retries;
 *    - events are only a hint that something changed. Stripe does not order
 *      them, so subscription state is re-read from Stripe and written, never
 *      taken from the event snapshot.
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

  let claim;
  try {
    claim = await claimWebhookEvent(event.id, event.type);
  } catch (err) {
    console.error("stripe webhook claim failed", event.id, err);
    return NextResponse.json({ error: "could not record event" }, { status: 500 });
  }
  if (claim === "duplicate") {
    return NextResponse.json({ received: true, duplicate: true });
  }
  if (claim === "in_progress") {
    // Non-2xx so Stripe redelivers once the other attempt has finished or gone stale.
    return NextResponse.json({ error: "event is being processed" }, {
      status: 503, headers: { "retry-after": "30" },
    });
  }

  try {
    await apply(s, event);
    await finishWebhookEvent(event.id);
  } catch (err) {
    console.error("stripe webhook failed", event.type, err);
    try {
      await finishWebhookEvent(event.id, err instanceof Error ? err.message : String(err));
    } catch (markErr) {
      // Left as processing; the claim goes stale and Stripe's retry redoes it.
      console.error("stripe webhook could not record failure", event.id, markErr);
    }
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
      await reconcile(s, accountId, customerId, subId);
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
      if (event.type === "customer.subscription.deleted") {
        await clearSubscriptionIfCurrent(accountId, sub.id);
      } else {
        await reconcile(s, accountId, customerId, sub.id);
      }
      break;
    }

    default:
      break;
  }
}

/** Writes Stripe's CURRENT state for a subscription, whatever the event that
 *  prompted it said. A subscription that has ended (or no longer exists)
 *  downgrades the account only if it is the one the account holds. */
async function reconcile(s: Stripe, accountId: string, customerId: string | null, subId: string) {
  let sub: Stripe.Subscription;
  try {
    sub = await s.subscriptions.retrieve(subId);
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      await clearSubscriptionIfCurrent(accountId, subId);
      return;
    }
    throw err;
  }
  if (sub.status === "canceled" || sub.status === "incomplete_expired") {
    await clearSubscriptionIfCurrent(accountId, sub.id);
    return;
  }
  const applied = await applySubscriptionState(accountId, customerId, fromSubscription(sub));
  if (!applied) console.warn("ignored subscription", sub.id, "for account", accountId);
}

function fromSubscription(sub: Stripe.Subscription) {
  const item = sub.items.data[0];
  const plan = item?.price?.id ? planForPriceId(item.price.id) : null;
  // `current_period_end` lives on the item in recent API versions.
  const periodEnd = (item as unknown as { current_period_end?: number })?.current_period_end
    ?? (sub as unknown as { current_period_end?: number }).current_period_end;
  return {
    stripe_subscription_id: sub.id,
    stripe_subscription_created: sub.created,
    plan: plan ?? ("free" as const),
    status: sub.status,
    current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
  };
}
