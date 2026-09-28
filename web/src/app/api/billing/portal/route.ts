import { NextResponse } from "next/server";
import { currentViewer } from "@/lib/auth";
import { siteUrl, stripe } from "@/lib/stripe";
import { subscriptionFor } from "@/lib/store";

export const runtime = "nodejs";

/** The customer portal is where plan changes, card updates and cancellation
 *  happen. Doing those ourselves would mean reimplementing proration and
 *  dunning; Stripe already has them. */
export async function POST() {
  const viewer = await currentViewer();
  if (!viewer) return NextResponse.json({ error: "sign in first" }, { status: 401 });

  const s = stripe();
  if (!s) return NextResponse.json({ error: "billing not configured" }, { status: 503 });

  // Viewer stays lean (plan + limits only); billing internals are loaded here.
  const { stripe_customer_id: customerId } = await subscriptionFor(viewer.account.id);
  if (!customerId) {
    return NextResponse.json({ error: "no billing account yet" }, { status: 400 });
  }

  const session = await s.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${siteUrl()}/account`,
  });
  return NextResponse.json({ url: session.url });
}
