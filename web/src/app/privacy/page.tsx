export const metadata = {
  title: "Privacy",
  description: "What HTSDesk collects, why, and how long it is kept.",
};

const UPDATED = "19 September 2026";

export default function PrivacyPage() {
  return (
    <article className="mx-auto max-w-[720px] space-y-6 py-2">
      <header className="space-y-2">
        <h1 className="serif text-4xl tracking-tight">Privacy</h1>
        <p className="text-[13px] text-faint">Last updated {UPDATED}</p>
      </header>

      <Section title="The short version">
        <p>
          We hold your email, a hash of your password, the product catalogues
          you save, and the codes you watch. We do not sell any of it, we do not
          use your catalogues to advertise to you, and we do not run third-party
          analytics or advertising trackers on this site.
        </p>
      </Section>

      <Section title="What we collect">
        <p>
          <strong>Account.</strong> Your email address and a scrypt hash of your
          password. We never store the password itself and cannot recover it.
        </p>
        <p>
          <strong>What you put in.</strong> Product descriptions, countries of
          origin, values, and any HTS codes in the catalogues you save. Treat
          this as commercially sensitive — we do.
        </p>
        <p>
          <strong>Payment.</strong> None. HTSDesk is free during its beta, so we
          collect no card or payment details.
        </p>
        <p>
          <strong>Operational logs.</strong> Ordinary web server logs, including
          IP address, for security and rate limiting.
        </p>
      </Section>

      <Section title="What we do with it">
        <p>
          Your catalogues exist so we can price them and watch the codes in
          them. The codes you watch are matched against tariff actions published
          in the Federal Register so we can tell you when one affects you. That
          is the whole purpose.
        </p>
        <p>
          Audits you run without an account are processed and discarded; nothing
          is stored against you.
        </p>
      </Section>

      <Section title="Who else sees it">
        <p>
          Our hosting and email providers, as processors. Nobody else, unless we are legally compelled — in which
          case we will tell you where we are permitted to.
        </p>
        <p>
          We do not share catalogue contents with CBP, brokers, or anyone else.
        </p>
      </Section>

      <Section title="How long we keep it">
        <p>
          Catalogues and watched codes stay until you delete them or close your
          account. Deleting a catalogue removes its items and the watches it
          created. Closing your account deletes the account, its catalogues,
          watches and alerts.
        </p>
      </Section>

      <Section title="Your choices">
        <p>
          You can export any catalogue as CSV, delete catalogues individually,
          and ask us to delete your account entirely by emailing{" "}
          <a href="mailto:privacy@htsdesk.com">privacy@htsdesk.com</a>.
          Depending on where you live you may also have rights to access,
          correct or port your data; ask and we will do it.
        </p>
      </Section>

      <Section title="Cookies">
        <p>
          One cookie, holding your session, set when you sign in. It is httpOnly
          and same-site. There are no advertising or analytics cookies, so there
          is nothing to consent to.
        </p>
      </Section>

      <Section title="Contact">
        <p>
          <a href="mailto:privacy@htsdesk.com">privacy@htsdesk.com</a>.
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
