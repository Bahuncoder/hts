import Link from "next/link";
import { PLAN_LIMITS, windowLabel, type PlanId } from "@/lib/plans";
import { Card } from "@/components/ui";

export const metadata = {
  title: "API documentation",
  description: "How to call the HTSDesk duty engine from your own backend.",
};

const PAID_PLANS: PlanId[] = ["starter", "growth"];

function Pre({ children }: { children: string }) {
  return (
    <pre className="mono overflow-x-auto rounded border border-rule bg-surface p-4 text-[12.5px] leading-[1.6]">
      {children}
    </pre>
  );
}

const REQUEST_EXAMPLE = `curl -X POST https://your-htsdesk-domain/api/v1/audit \\
  -H "Authorization: Bearer htsd_..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "items": [
      { "description": "cotton t-shirt", "country": "China", "value": 1500 }
    ]
  }'`;

const RESPONSE_EXAMPLE = `{
  "summary": {
    "submitted": 1, "items": 1, "processed": 1, "priced": 1,
    "totals_complete": true, "entered_value": 1500.0,
    "duty": 227.5, "effective_rate_pct": 15.17,
    "potentially_refundable": 0.0, "dataset_revision": "..."
  },
  "lines": [{
    "row": 1, "description": "cotton t-shirt", "country": "China",
    "hts": "6109.10.00.12", "confidence": "high", "status": "low_confidence",
    "duty": 227.5, "effective_rate_pct": 15.17, "refundable": 0.0,
    "review_reasons": ["High-confidence classification suggested by the tool; not yet confirmed by a person."]
  }]
}`;

export default function ApiDocsPage() {
  return (
    <div className="space-y-9">
      <div className="max-w-[720px] space-y-3">
        <h1 className="serif text-4xl leading-[1.06] tracking-tight">API</h1>
        <p className="text-[16px] text-muted">
          Call the same duty engine the web app uses, from your own backend.
          Available on the Starter and Growth plans —{" "}
          <Link href="/account/api-keys" className="font-medium text-accent hover:underline">manage your keys</Link>,
          or <Link href="/pricing" className="font-medium text-accent hover:underline">see plans</Link> if
          your account does not have API access yet.
        </p>
      </div>

      <div className="space-y-3">
        <h2 className="text-[15px] font-semibold">Authentication</h2>
        <p className="text-[14px] text-muted">
          Send your key as a bearer token. A key is a server-side credential
          for your own backend — never put it in code that runs in a browser,
          the same way you would not ship a database password to a client.
        </p>
        <Pre>{"Authorization: Bearer htsd_..."}</Pre>
      </div>

      <div className="space-y-3">
        <h2 className="text-[15px] font-semibold">POST /api/v1/audit</h2>
        <p className="text-[14px] text-muted">
          Prices and classifies a list of products in one call: each line
          comes back with an HTS code (if one could be found), the duty
          owed, and the CBP ruling evidence behind it. Every submitted row is
          returned, whether or not it could be fully priced — a row is never
          silently dropped.
        </p>

        <h3 className="text-[13px] font-semibold text-muted">Request</h3>
        <Pre>{REQUEST_EXAMPLE}</Pre>
        <p className="text-[13px] text-muted">
          Each item in <code className="mono">items</code> takes a{" "}
          <code className="mono">description</code>, <code className="mono">country</code> of
          origin, and entered <code className="mono">value</code>, plus optional fields
          used only when they apply: <code className="mono">hts</code> (skip
          classification if you already know the code), <code className="mono">quantity</code>/
          <code className="mono">quantity_unit</code> (needed for a per-unit duty), <code className="mono">preference_program</code> (a
          trade-preference program you are claiming), <code className="mono">metal_weight_pct</code>,
          and <code className="mono">vehicle_use</code>.
        </p>

        <h3 className="text-[13px] font-semibold text-muted">Response</h3>
        <Pre>{RESPONSE_EXAMPLE}</Pre>
        <p className="text-[13px] text-muted">
          <code className="mono">summary</code> covers the whole request (totals,
          how many lines were fully priced); <code className="mono">lines</code> has
          one entry per submitted item, in order. A line whose classification came
          from the tool rather than your own <code className="mono">hts</code> is
          marked <code className="mono">status: low_confidence</code> until a
          person confirms it — never presented as decided.
        </p>
      </div>

      <div className="space-y-3">
        <h2 className="text-[15px] font-semibold">Errors</h2>
        <div className="scroll-x">
          <table className="w-full min-w-[520px] text-[13px]">
            <thead>
              <tr className="border-b border-border text-left text-faint">
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 pr-4 font-medium">error</th>
                <th className="py-2 font-medium">Meaning</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["401", "unauthorized", "Missing, malformed, unknown, or revoked key."],
                ["403", "forbidden", "The key's plan does not include API access."],
                ["400", "bad_request", "Malformed JSON, or no items given."],
                ["413", "too_large", "More items than your plan allows in one request."],
                ["429", "rate_limited", "Per-minute rate or daily item allowance exceeded; retry after the Retry-After header."],
                ["502", "engine_unavailable", "The engine could not process the request. Retry shortly — you were not charged."],
              ].map(([status, error, meaning]) => (
                <tr key={error} className="border-b border-hair">
                  <td className="mono py-2 pr-4">{status}</td>
                  <td className="mono py-2 pr-4">{error}</td>
                  <td className="py-2 text-muted">{meaning}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="space-y-3">
        <h2 className="text-[15px] font-semibold">Rate limits</h2>
        <p className="text-[14px] text-muted">
          Independent of your plan&rsquo;s web-app allowance — an integration
          running on a schedule will not compete with your team&rsquo;s manual
          use of the web app, or the other way around.
        </p>
        <div className="grid gap-5 sm:grid-cols-2">
          {PAID_PLANS.map((id) => {
            const { api, productsPerAudit } = PLAN_LIMITS[id];
            return (
              <Card key={id}>
                <div className="lbl">{id === "starter" ? "Starter" : "Growth"}</div>
                <dl className="mt-2 space-y-1 text-[13px]">
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted">Products per request</dt>
                    <dd className="mono">{productsPerAudit.toLocaleString()}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted">Requests per {windowLabel(api.requests.windowMs)}</dt>
                    <dd className="mono">{api.requests.max.toLocaleString()}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted">Products per day</dt>
                    <dd className="mono">{api.itemsPerDay.max.toLocaleString()}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted">Keys</dt>
                    <dd className="mono">{api.maxKeys}</dd>
                  </div>
                </dl>
              </Card>
            );
          })}
        </div>
      </div>

      <div className="space-y-3 border-t border-border pt-7">
        <h2 className="text-[15px] font-semibold">Rotating a key</h2>
        <p className="text-[13.5px] leading-[1.55] text-muted">
          Your plan&rsquo;s key limit exists as much for rotation as for
          running several integrations: create a new key, update your
          integration to use it, then revoke the old one from{" "}
          <Link href="/account/api-keys" className="font-medium text-accent hover:underline">your key list</Link>.
          A revoked key stops working immediately.
        </p>
      </div>
    </div>
  );
}
