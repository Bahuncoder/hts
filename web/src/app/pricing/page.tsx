import { currentViewer } from "@/lib/auth";
import { IN_BUILD, PLANS, type PlanId } from "@/lib/plans";
import { billingEnabled } from "@/lib/stripe";
import { SubscribeButton } from "@/components/BillingButtons";
import { Note } from "@/components/ui";

export const metadata = {
  title: "Pricing",
  description:
    "HTSDesk pricing. Classify 25 products free, then $99, $499 or $1,999 a month by catalogue size.",
};

export const dynamic = "force-dynamic";

const ORDER: PlanId[] = ["free", "starter", "growth"];

function Tick() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" className="mt-[3px] shrink-0" aria-hidden="true">
      <path d="M3 8.5l3.2 3.2L13 5" stroke="currentColor" strokeWidth="2" fill="none"
            strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default async function PricingPage() {
  const viewer = await currentViewer();
  const signedIn = Boolean(viewer);
  const current = viewer?.plan.id ?? null;

  return (
    <div className="space-y-9">
      <div className="max-w-[720px] space-y-3">
        <h1 className="serif text-4xl leading-[1.06] tracking-tight">
          Priced against what you&rsquo;d otherwise overpay
        </h1>
        <p className="text-[16px]" style={{ color: "var(--muted)" }}>
          A single misclassified entry averages{" "}
          <span className="mono" style={{ color: "var(--ink)" }}>$3,847</span> in duty you did not
          owe. Every plan bills monthly and cancels in one click.
        </p>
      </div>

      {!billingEnabled() ? (
        <Note>
          Billing is not switched on yet — the paid plans cannot be purchased until
          Stripe keys are configured. Free accounts work now.
        </Note>
      ) : null}

      <div className="grid gap-5 md:grid-cols-3">
        {ORDER.map((id) => {
          const plan = PLANS[id];
          const isCurrent = current === id;
          const featured = id === "growth";
          return (
            <div key={id} className="relative flex flex-col gap-4 p-6"
                 style={{
                   background: "var(--surface)",
                   color: "var(--ink)",
                   border: featured ? "1.5px solid var(--accent)" : "1px solid var(--border)",
                 }}>
              {featured ? (
                <span className="absolute -top-[11px] left-6 px-2 py-1 text-[10px] font-semibold tracking-[0.1em]"
                      style={{ background: "var(--accent)", color: "var(--on-accent)" }}>
                  MOST IMPORTERS
                </span>
              ) : null}

              <div className="space-y-1">
                <div className="lbl" style={featured ? { color: "var(--accent)" } : undefined}>
                  {plan.name}
                </div>
                <div className="flex items-baseline gap-1">
                  <span className="mono text-[34px] font-medium tracking-[-0.02em]">
                    ${plan.priceMonthly.toLocaleString()}
                  </span>
                  {plan.priceMonthly > 0 ? (
                    <span className="text-[14px]" style={{ color: "var(--faint)" }}>/month</span>
                  ) : null}
                </div>
                <div className="text-[13px]" style={{ color: "var(--faint)" }}>{plan.blurb}</div>
              </div>

              <div style={{ height: 1, background: "var(--hair)" }} />

              <ul className="flex flex-col gap-2.5 text-[13.5px] leading-[1.45]">
                {plan.features.map((f) => (
                  <li key={f} className="flex gap-2">
                    <span style={{ color: "var(--accent)" }}><Tick /></span>
                    <span>{f}</span>
                  </li>
                ))}
              </ul>

              <div className="mt-auto pt-2">
                {isCurrent ? (
                  <div className="py-2.5 text-center text-[14px] font-medium"
                       style={{ border: "1px dashed var(--rule)", color: "var(--faint)" }}>
                    Your current plan
                  </div>
                ) : id === "free" ? (
                  <a href={signedIn ? "/account" : "/signup"}
                     className="block py-2.5 text-center text-[14px] font-medium"
                     style={{ border: "1px solid var(--rule)" }}>
                    {signedIn ? "Included" : "Start free"}
                  </a>
                ) : (
                  <SubscribeButton plan={id} signedIn={signedIn} primary={featured}
                                   label={`Choose ${plan.name}`} />
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-baseline gap-2 text-[14px]"
           style={{ color: "var(--muted)" }}>
        <span>Bigger catalogue, a broker workspace, or several importers under one login?</span>
        <a href="mailto:hello@htsdesk.com" className="font-medium hover:underline"
           style={{ color: "var(--accent)" }}>Tell us what you need</a>
      </div>

      <div className="space-y-3 border-t pt-7" style={{ borderColor: "var(--border)" }}>
        <h2 className="text-[15px] font-semibold">Being built, and not yet sold</h2>
        <p className="text-[13.5px] leading-[1.55]" style={{ color: "var(--muted)" }}>
          These are on the way. They are listed here rather than inside a plan
          because none of them work yet, and a price list is a promise.
        </p>
        <ul className="grid gap-1.5 text-[13.5px] sm:grid-cols-2" style={{ color: "var(--muted)" }}>
          {IN_BUILD.map((f) => <li key={f}>· {f}</li>)}
        </ul>
      </div>

      <div className="grid gap-6 border-t pt-7 md:grid-cols-2" style={{ borderColor: "var(--border)" }}>
        <div className="space-y-1.5">
          <h2 className="text-[15px] font-semibold">What we do not do</h2>
          <p className="text-[13.5px] leading-[1.55]" style={{ color: "var(--muted)" }}>
            We do not file entries, and we are not your customs broker. HTSDesk is
            decision support: it finds candidate classifications, shows the CBP
            rulings behind them, and prices the duty. Your broker signs off.
          </p>
        </div>
        <div className="space-y-1.5">
          <h2 className="text-[15px] font-semibold">Where a figure is uncertain, we say so</h2>
          <p className="text-[13.5px] leading-[1.55]" style={{ color: "var(--muted)" }}>
            Remedies whose product scope lives in the U.S. Notes are withheld from the
            total and listed separately. You will see an understated figure with a
            flag, never a confident wrong one.
          </p>
        </div>
      </div>
    </div>
  );
}
