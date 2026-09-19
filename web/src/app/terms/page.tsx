export const metadata = {
  title: "Terms of service",
  description: "The terms on which HTSDesk is provided.",
};

const UPDATED = "26 August 2026";

export default function TermsPage() {
  return (
    <article className="mx-auto max-w-[720px] space-y-6 py-2">
      <header className="space-y-2">
        <h1 className="serif text-4xl tracking-tight">Terms of service</h1>
        <p className="text-[13px] text-faint">Last updated {UPDATED}</p>
      </header>

      <Section title="1. What HTSDesk is">
        <p>
          HTSDesk is a decision-support tool for people importing goods into the
          United States. It suggests candidate classifications under the
          Harmonized Tariff Schedule, shows the U.S. Customs and Border
          Protection rulings that support them, and estimates duty.
        </p>
        <p>
          <strong>
            HTSDesk is not a customs broker, a law firm, or a tax adviser, and
            nothing it produces is legal or customs advice.
          </strong>{" "}
          We do not file entries and we do not act as your agent before CBP.
        </p>
      </Section>

      <Section title="2. Your duty of reasonable care">
        <p>
          Under 19 U.S.C. §1484 the importer of record is responsible for using
          reasonable care to enter, classify and value imported merchandise and
          to provide any other information needed for CBP to assess duties
          correctly. That responsibility is yours and cannot be delegated to us
          by using this service.
        </p>
        <p>
          Classifications we suggest are ranked from precedent and are
          frequently wrong on the first attempt. Confirm every classification
          with your customs broker or counsel before it is used on an entry.
        </p>
      </Section>

      <Section title="3. Accuracy, and where we deliberately say less">
        <p>
          Our figures derive from public sources — the USITC Harmonized Tariff
          Schedule, the Chapter 99 U.S. Notes and the Federal Register. Those
          sources change frequently and can themselves contain errors.
        </p>
        <p>
          Where a trade remedy&rsquo;s product scope is defined in prose we
          cannot resolve mechanically, we exclude that remedy from the duty
          figure and flag it, rather than guessing. Duty figures may therefore
          be understated. Where a provision has been struck down but remains
          printed in the schedule, we report it separately as a scenario
          estimate of duty that may be recoverable, rather than as duty owed.
          That figure is calculated for one entry at the value you enter; we do
          not know which entries you filed, what you paid or their liquidation
          status, so it is not a claim amount. Neither treatment is a promise
          about what CBP will assess or refund.
        </p>
      </Section>

      <Section title="4. Accounts">
        <p>
          You are responsible for activity under your account and for keeping
          your password secure. Tell us promptly if you believe it has been
          compromised. Do not share one account across people beyond the seats
          your plan includes.
        </p>
      </Section>

      <Section title="5. Plans, billing and cancellation">
        <p>
          Paid plans bill monthly in advance through Stripe. Prices are in US
          dollars and exclude any tax we are required to collect. You can cancel
          at any time from the billing portal; your plan continues until the end
          of the period you have paid for and is not refunded pro rata.
        </p>
        <p>
          If a payment fails, your account falls back to the free plan&rsquo;s
          limits rather than being locked; your saved catalogues stay where they
          are.
        </p>
      </Section>

      <Section title="6. Acceptable use">
        <p>
          Do not attempt to scrape the service in bulk, resell access,
          circumvent plan limits or rate limits, or use HTSDesk to build a
          competing tariff database. We may suspend an account that does.
        </p>
      </Section>

      <Section title="7. Liability">
        <p>
          HTSDesk is provided as-is. To the fullest extent the law allows, we
          are not liable for duties, penalties, interest, seizure, delay or lost
          profit arising from a classification, valuation or duty figure you
          obtained here. Our total liability for any claim is limited to the
          amount you paid us in the twelve months before it arose.
        </p>
        <p>Nothing here excludes liability that cannot lawfully be excluded.</p>
      </Section>

      <Section title="8. Changes and contact">
        <p>
          We may change these terms; material changes will be notified by email
          to account holders. Questions go to{" "}
          <a href="mailto:hello@htsdesk.com">hello@htsdesk.com</a>.
        </p>
      </Section>
    </article>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2.5">
      <h2 className="text-[17px] font-semibold">{title}</h2>
      <div className="space-y-2.5 text-[15px] leading-[1.6] text-muted">
        {children}
      </div>
    </section>
  );
}
