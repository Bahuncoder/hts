import { currentViewer } from "@/lib/auth";
import { IN_BUILD, PAID_PLANS, PLANS, priceIdFor, type PlanId } from "@/lib/plans";
import { billingEnabled } from "@/lib/stripe";
import { SubscribeButton } from "@/components/BillingButtons";
import { Note } from "@/components/ui";

// Derived from PLANS so the search-result line can never name a tier that
// does not exist.
const paidPrices = PAID_PLANS.map((id) => `$${PLANS[id].priceMonthly.toLocaleString("en-US")}`);
export const metadata = {
  title: "Pricing",
  description: `HTSDesk pricing. Audit ${PLANS.free.skus} products free, then ${paidPrices.join(" or ")} a month by catalogue size.`,
};

export const dynamic = "force-dynamic";

const ORDER: PlanId[] = ["free", "starter", "growth"];

function Tick() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      className="mt-[3px] shrink-0"
      aria-hidden="true"
    >
      <path
        d="M3 8.5l3.2 3.2L13 5"
        stroke="currentColor"
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A paid plan can be bought only if checkout is configured and this plan has
 *  a price behind it; otherwise the button would lead to a failed purchase. */
const purchasable = (id: PlanId) => billingEnabled() && Boolean(priceIdFor(id));

export default async function PricingPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string }>;
}) {
  const { checkout } = await searchParams;
  const viewer = await currentViewer();
  const signedIn = Boolean(viewer);
  const current = viewer?.plan.id ?? null;

  return (
    <div className="space-y-9">
      <div className="max-w-[720px] space-y-3">
        <h1 className="serif text-4xl leading-[1.06] tracking-tight">
          Plans by catalogue size
        </h1>
        <p className="text-[16px] text-muted">
          Start free. Paid plans bill monthly and raise the number of products
          you can audit, save and monitor.
        </p>
      </div>

      {checkout === "cancelled" ? (
        <Note role="status">
          Checkout was cancelled. Nothing was charged.
        </Note>
      ) : null}

      {PAID_PLANS.some((id) => !purchasable(id)) ? (
        <Note role="status">
          Paid plans are not open for purchase yet. Free accounts work now.
        </Note>
      ) : null}

      <div className="grid gap-5 md:grid-cols-3">
        {ORDER.map((id) => {
          const plan = PLANS[id];
          const isCurrent = current === id;
          return (
            <div
              key={id}
              className="flex flex-col gap-4 p-6"
              style={{
                background: "var(--surface)",
                color: "var(--ink)",
                border: "1px solid var(--border)",
              }}
            >

              <div className="space-y-1">
                <h2 className="lbl">{plan.name}</h2>
                <div className="flex items-baseline gap-1">
                  <span className="mono text-[34px] font-medium tracking-[-0.02em]">
                    ${plan.priceMonthly.toLocaleString()}
                  </span>
                  {plan.priceMonthly > 0 ? (
                    <span className="text-[14px] text-faint">/month</span>
                  ) : null}
                </div>
                <div className="text-[13px] text-faint">{plan.blurb}</div>
              </div>

              <div style={{ height: 1, background: "var(--hair)" }} />

              <ul className="flex flex-col gap-2.5 text-[13.5px] leading-[1.45]">
                {plan.features.map((f) => (
                  <li key={f} className="flex gap-2">
                    <span className="text-accent">
                      <Tick />
                    </span>
                    <span>{f}</span>
                  </li>
                ))}
              </ul>

              <div className="mt-auto pt-2">
                {isCurrent ? (
                  <div
                    className="py-2.5 text-center text-[14px] font-medium"
                    style={{
                      border: "1px dashed var(--rule)",
                      color: "var(--faint)",
                    }}
                  >
                    Your current plan
                  </div>
                ) : id === "free" ? (
                  <a
                    href={signedIn ? "/account" : "/signup"}
                    className="block py-2.5 text-center text-[14px] font-medium border border-rule"
                  >
                    {signedIn ? "Included" : "Start free"}
                  </a>
                ) : purchasable(id) ? (
                  <SubscribeButton
                    plan={id}
                    signedIn={signedIn}
                    label={`Choose ${plan.name}`}
                  />
                ) : (
                  <button
                    type="button"
                    disabled
                    className="w-full py-2.5 text-[14px] font-medium border border-rule text-faint opacity-70"
                  >
                    Not available yet
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-baseline gap-2 text-[14px] text-muted">
        <span>
          Bigger catalogue, a broker workspace, or several importers under one
          login?
        </span>
        <a
          href="mailto:hello@htsdesk.com"
          className="font-medium hover:underline text-accent"
        >
          Tell us what you need
        </a>
      </div>

      <div className="space-y-3 border-t pt-7 border-border">
        <h2 className="text-[15px] font-semibold">
          Being built, and not yet sold
        </h2>
        <p className="text-[13.5px] leading-[1.55] text-muted">
          These are on the way. They are listed here rather than inside a plan
          because none of them work yet, and a price list is a promise.
        </p>
        <ul className="grid gap-1.5 text-[13.5px] sm:grid-cols-2 text-muted">
          {IN_BUILD.map((f) => (
            <li key={f}>· {f}</li>
          ))}
        </ul>
      </div>

      <div className="grid gap-6 border-t pt-7 md:grid-cols-2 border-border">
        <div className="space-y-1.5">
          <h2 className="text-[15px] font-semibold">What we do not do</h2>
          <p className="text-[13.5px] leading-[1.55] text-muted">
            We do not file entries, and we are not your customs broker. HTSDesk
            is decision support: it finds candidate classifications, shows the
            CBP rulings behind them, and prices the duty. Your broker signs off.
          </p>
        </div>
        <div className="space-y-1.5">
          <h2 className="text-[15px] font-semibold">
            Where a figure is uncertain, we say so
          </h2>
          <p className="text-[13.5px] leading-[1.55] text-muted">
            Remedies whose product scope lives in the U.S. Notes are withheld
            from the total and listed separately. When a figure leaves
            something out, it is marked incomplete next to the number, with the
            reason.
          </p>
        </div>
      </div>
    </div>
  );
}
