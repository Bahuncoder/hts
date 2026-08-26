import type { Alert } from "../diff";
import { unsubscribeToken } from "../email";

const SITE = process.env.SITE_URL ?? "https://htsdesk.com";

export type Digest = {
  subject: string;
  text: string;
  html: string;
};

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Groups alerts by document, because one action commonly names several of a
 *  customer's codes and listing it once per code reads as spam. */
function group(alerts: Alert[]) {
  const byDoc = new Map<string, { alert: Alert; codes: string[] }>();
  for (const a of alerts) {
    const entry = byDoc.get(a.document_number);
    if (entry) {
      if (!entry.codes.includes(a.hts)) entry.codes.push(a.hts);
    } else {
      byDoc.set(a.document_number, { alert: a, codes: [a.hts] });
    }
  }
  return [...byDoc.values()].sort(
    (x, y) => y.alert.publication_date.localeCompare(x.alert.publication_date),
  );
}

export function renderAlertDigest(accountId: string, alerts: Alert[]): Digest {
  const docs = group(alerts);
  const codes = [...new Set(alerts.map((a) => a.hts))];

  const subject =
    docs.length === 1
      ? `Tariff action touching ${codes.length === 1 ? codes[0] : `${codes.length} of your codes`}`
      : `${docs.length} tariff actions touching your codes`;

  const unsub = `${SITE}/unsubscribe?a=${encodeURIComponent(accountId)}&t=${unsubscribeToken(accountId)}`;

  const text = [
    docs.length === 1
      ? "A tariff action published in the Federal Register names a code you watch."
      : `${docs.length} tariff actions published in the Federal Register name codes you watch.`,
    "",
    ...docs.flatMap(({ alert, codes: cs }) => [
      `${alert.publication_date}  ${cs.join(", ")}`,
      alert.title,
      alert.html_url,
      "",
    ]),
    `See them in HTSDesk: ${SITE}/alerts`,
    "",
    "This is not customs advice. Whether an action changes your duty depends on",
    "the scope defined in the notice — read it, and confirm with your broker.",
    "",
    `Stop these emails: ${unsub}`,
  ].join("\n");

  const rows = docs.map(({ alert, codes: cs }) => `
    <tr><td style="padding:0 0 20px 0;">
      <div style="font:12px ui-monospace,Menlo,monospace;color:#6b7a75;letter-spacing:.04em;">
        ${esc(alert.publication_date)} &nbsp;·&nbsp; ${cs.map((c) => `<span style="color:#0d5142;">${esc(c)}</span>`).join(" &nbsp; ")}
      </div>
      <a href="${esc(alert.html_url)}" style="display:block;margin-top:5px;font:600 16px/1.35 ui-sans-serif,system-ui,sans-serif;color:#161c1a;text-decoration:none;">
        ${esc(alert.title)}
      </a>
    </td></tr>`).join("");

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#faf9f6;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#faf9f6;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e4e2da;">
  <tr><td style="padding:26px 28px 0 28px;">
    <div style="font:600 17px ui-sans-serif,system-ui,sans-serif;color:#161c1a;letter-spacing:-.015em;">
      HTS<span style="color:#4d5b56;font-weight:450;">Desk</span>
    </div>
  </td></tr>
  <tr><td style="padding:18px 28px 0 28px;">
    <div style="font:400 16px/1.5 ui-sans-serif,system-ui,sans-serif;color:#3d4a45;">
      ${docs.length === 1
        ? "A tariff action published in the Federal Register names a code you watch."
        : `${docs.length} tariff actions published in the Federal Register name codes you watch.`}
    </div>
  </td></tr>
  <tr><td style="padding:22px 28px 0 28px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
  </td></tr>
  <tr><td style="padding:0 28px 26px 28px;">
    <a href="${SITE}/alerts" style="display:inline-block;background:#0d5142;color:#ffffff;padding:11px 18px;font:500 14px ui-sans-serif,system-ui,sans-serif;text-decoration:none;">
      See them in HTSDesk
    </a>
  </td></tr>
  <tr><td style="padding:18px 28px 24px 28px;border-top:1px solid #efede7;">
    <div style="font:400 12px/1.5 ui-sans-serif,system-ui,sans-serif;color:#6b7a75;">
      This is not customs advice. Whether an action changes your duty depends on the
      scope defined in the notice — read it, and confirm with your broker.
    </div>
    <div style="margin-top:10px;font:400 12px ui-sans-serif,system-ui,sans-serif;color:#6b7a75;">
      <a href="${esc(unsub)}" style="color:#6b7a75;">Stop these emails</a>
    </div>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

  return { subject, text, html };
}
