import { MAIL, escapeHtml } from "./palette";
const SITE = process.env.SITE_URL ?? "https://htsdesk.com";


function shell(intro: string, action: string, href: string, footer: string): string {
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:${MAIL.paper};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${MAIL.paper};">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:${MAIL.surface};border:1px solid ${MAIL.border};">
  <tr><td style="padding:26px 28px 0 28px;">
    <div style="font:600 17px ui-sans-serif,system-ui,sans-serif;color:${MAIL.ink};letter-spacing:-.015em;">
      HTS<span style="color:${MAIL.muted};font-weight:450;">Desk</span>
    </div>
  </td></tr>
  <tr><td style="padding:18px 28px 0 28px;">
    <div style="font:400 16px/1.5 ui-sans-serif,system-ui,sans-serif;color:${MAIL.body};">${escapeHtml(intro)}</div>
  </td></tr>
  <tr><td style="padding:22px 28px 0 28px;">
    <a href="${escapeHtml(href)}" style="display:inline-block;background:${MAIL.accent};color:${MAIL.surface};padding:12px 20px;font:500 14px ui-sans-serif,system-ui,sans-serif;text-decoration:none;">${escapeHtml(action)}</a>
  </td></tr>
  <tr><td style="padding:18px 28px 26px 28px;">
    <div style="font:400 12px/1.5 ui-sans-serif,system-ui,sans-serif;color:${MAIL.faint};">${escapeHtml(footer)}</div>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

export function passwordResetEmail(token: string) {
  const href = `${SITE}/reset?token=${encodeURIComponent(token)}`;
  const intro = "Someone asked to reset the password on your HTSDesk account. " +
                "If it was you, use the link below. It expires in an hour.";
  const footer = "If you did not ask for this, nothing has changed and you can " +
                 "ignore this email. Your password is unchanged until the link is used.";
  return {
    subject: "Reset your HTSDesk password",
    text: `${intro}\n\n${href}\n\n${footer}`,
    html: shell(intro, "Set a new password", href, footer),
  };
}

export function verifyEmail(token: string) {
  const href = `${SITE}/verify?token=${encodeURIComponent(token)}`;
  const intro = "Confirm this address to finish setting up your HTSDesk account. " +
                "The link works for three days.";
  const footer = "If you did not sign up, ignore this email — no account is " +
                 "created until the link is used.";
  return {
    subject: "Confirm your email for HTSDesk",
    text: `${intro}\n\n${href}\n\n${footer}`,
    html: shell(intro, "Confirm this address", href, footer),
  };
}
