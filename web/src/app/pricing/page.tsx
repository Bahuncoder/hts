import { currentViewer } from "@/lib/auth";
import { IN_BUILD, PLAN_COPY, PLAN_PRICE_MONTHLY, type PlanId } from "@/lib/plans";
import { billingEnabled } from "@/lib/stripe";
import { SubscribeButton } from "@/components/BillingButtons";
import { Card, Note } from "@/components/ui";

export const metadata = {
  title: "Pricing",
  description: "HTSDesk pricing: a free tier for a first catalogue, and paid plans by scale.",
};

export const dynamic = "force-dynamic";

const ORDER: PlanId[] = ["free", "starter", "growth"];

export default async function PricingPage() {
  const viewer = await currentViewer();
  const signedIn = Boolean(viewer);
  const current = viewer?.plan ?? null;

  return (
    <div className="space-y-9">
      <div className="max-w-[720px] space-y-3">
        <h1 className="serif text-4xl leading-[1.06] tracking-tight">
          Plans by scale, not by feature
        </h1>
        <p className="text-[16px] text-muted">
          The duty engine, the classifier and the evidence behind every code
          are the same on every plan. What changes is how much catalogue you
          can run through them. Every paid plan bills monthly and cancels in
          one click, from the billing portal, any time.
        </p>
      </div>

      {!billingEnabled() ? (
        <Note>
          Billing is not switched on yet in this environment — the paid plans
          cannot be purchased until Stripe keys are configured. The free plan
          works now.
        </Note>
      ) : null}

      <div className="grid gap-5 md:grid-cols-3">
        {ORDER.map((id) => {
          const copy = PLAN_COPY[id];
          const price = PLAN_PRICE_MONTHLY[id];
          const isCurrent = current === id;
          const featured = id === "growth";
          return (
            <Card
              key={id}
              className={`flex flex-col gap-4${featured ? " border-accent" : ""}`}
            >
              {featured ? (
                <span className="w-fit rounded-full bg-accent px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-on-accent">
                  Most catalogues
                </span>
              ) : null}
              <div className="space-y-1">
                <div className="lbl">{copy.name}</div>
                <div className="flex items-baseline gap-1">
                  <span className="mono text-[34px] font-medium tracking-[-0.02em]">
                    ${price.toLocaleString()}
                  </span>
                  {price > 0 ? <span className="text-[14px] text-faint">/month</span> : null}
                </div>
                <div className="text-[13px] text-muted">{copy.blurb}</div>
              </div>

              <div className="h-px" style={{ background: "var(--hair)" }} />

              <ul className="flex flex-col gap-2.5 text-[13.5px] leading-[1.45]">
                {copy.features.map((f) => (
                  <li key={f} className="flex gap-2">
                    <span aria-hidden="true" className="mt-[3px] text-accent">✓</span>
                    <span>{f}</span>
                  </li>
                ))}
              </ul>

              <div className="mt-auto pt-2">
                {isCurrent ? (
                  <div className="rounded border border-dashed border-rule py-2.5 text-center text-[14px] font-medium text-faint">
                    Your current plan
                  </div>
                ) : id === "free" ? (
                  <a
                    href={signedIn ? "/account" : "/signup"}
                    className="btn btn-secondary w-full"
                  >
                    {signedIn ? "Included" : "Start free"}
                  </a>
                ) : (
                  <SubscribeButton
                    plan={id}
                    signedIn={signedIn}
                    primary={featured}
                    label={`Choose ${copy.name}`}
                  />
                )}
              </div>
            </Card>
          );
        })}
      </div>

      <div className="flex flex-wrap items-baseline gap-2 text-[14px] text-muted">
        <span>Bigger catalogue than Growth covers, or several importers under one login?</span>
        <a href="mailto:hello@htsdesk.com" className="font-medium text-accent hover:underline">
          Tell us what you need
        </a>
      </div>

      <div className="space-y-3 border-t border-border pt-7">
        <h2 className="text-[15px] font-semibold">Being built, and not yet sold</h2>
        <p className="text-[13.5px] leading-[1.55] text-muted">
          These are on the way. They are listed here rather than inside a plan
          because none of them work yet, and a price list is a promise.
        </p>
        <ul className="grid gap-1.5 text-[13.5px] text-muted sm:grid-cols-2">
          {IN_BUILD.map((f) => (
            <li key={f}>· {f}</li>
          ))}
        </ul>
      </div>

      <div className="grid gap-6 border-t border-border pt-7 md:grid-cols-2">
        <div className="space-y-1.5">
          <h2 className="text-[15px] font-semibold">What we do not do</h2>
          <p className="text-[13.5px] leading-[1.55] text-muted">
            We do not file entries, and we are not your customs broker. HTSDesk
            is decision support: it finds candidate classifications, shows the
            CBP rulings behind them, and prices the duty. Your broker signs off.
          </p>
        </div>
        <div className="space-y-1.5">
          <h2 className="text-[15px] font-semibold">Where a figure is uncertain, we say so</h2>
          <p className="text-[13.5px] leading-[1.55] text-muted">
            A classifier-suggested code is labelled as unconfirmed until a
            person reviews it, on every plan. You will see an honest flag,
            never a confident guess dressed up as a decision.
          </p>
        </div>
      </div>
    </div>
  );
}
