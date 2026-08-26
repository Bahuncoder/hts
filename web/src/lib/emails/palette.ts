/** The palette, as literal hex, for email only.
 *
 *  Email clients do not support CSS custom properties, so the tokens in
 *  globals.css cannot be referenced from a message. These values mirror the
 *  light theme deliberately: mail is read on a white ground regardless of the
 *  reader's system setting, and a dark-mode palette in an inbox reads as a
 *  rendering fault.
 *
 *  Kept in one file so a brand change is one edit rather than a hunt through
 *  every template.
 */
export const MAIL = {
  paper: "#faf9f6",
  surface: "#ffffff",
  border: "#e4e2da",
  hair: "#efede7",
  ink: "#161c1a",
  body: "#3d4a45",
  muted: "#4d5b56",
  faint: "#6b7a75",
  accent: "#0d5142",
  onAccent: "#ffffff",
  recover: "#a8501f",
} as const;

export const FONT = {
  sans: 'ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif',
  mono: 'ui-monospace,Menlo,Consolas,monospace',
} as const;

export const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;")
   .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
