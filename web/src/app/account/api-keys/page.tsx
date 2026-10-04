import Link from "next/link";
import { requireViewer } from "@/lib/auth";
import { listApiKeys } from "@/lib/apiKeys";
import { revokeApiKeyAction } from "@/lib/actions";
import { Card, Note } from "@/components/ui";
import { ApiKeyCreateForm } from "@/components/ApiKeyCreateForm";

export const metadata = { title: "API keys" };
export const dynamic = "force-dynamic";

export default async function ApiKeysPage() {
  const viewer = await requireViewer("/account/api-keys");
  const { limits } = viewer;

  const keys = limits.api.enabled ? await listApiKeys(viewer.account.id) : [];
  const active = keys.filter((k) => !k.revoked_at);

  return (
    <div className="space-y-8">
      <div className="space-y-1.5">
        <h1 className="serif text-3xl tracking-tight">API keys</h1>
        <p className="text-[14px] text-muted">
          Call the duty engine from your own backend instead of the web app.
          See the <Link href="/docs/api" className="font-medium text-accent hover:underline">API docs</Link> for
          the request shape and rate limits.
        </p>
      </div>

      {!limits.api.enabled ? (
        <Note>
          API access is not included on your current plan.{" "}
          <Link href="/pricing" className="font-medium underline">See plans</Link> to upgrade.
        </Note>
      ) : (
        <>
          <Card className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-[18px] font-semibold">Create a key</h2>
              <p className="text-[13px] text-faint">
                {active.length} of {limits.api.maxKeys} used
              </p>
            </div>
            {active.length >= limits.api.maxKeys ? (
              <Note>
                You have reached the maximum of {limits.api.maxKeys} keys. Revoke one below before creating another.
              </Note>
            ) : (
              <ApiKeyCreateForm />
            )}
          </Card>

          <div className="space-y-3">
            <h2 className="text-[18px] font-semibold">Your keys</h2>
            {keys.length === 0 ? (
              <p className="text-[13px] text-faint">No keys yet.</p>
            ) : (
              <div className="scroll-x">
                <table className="w-full min-w-[560px] text-[13px]">
                  <thead>
                    <tr className="border-b border-border text-left text-faint">
                      <th className="py-2 pr-4 font-medium">Name</th>
                      <th className="py-2 pr-4 font-medium">Key</th>
                      <th className="py-2 pr-4 font-medium">Created</th>
                      <th className="py-2 pr-4 font-medium">Last used</th>
                      <th className="py-2 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {keys.map((k) => (
                      <tr key={k.id} className="border-b border-hair">
                        <td className="py-2 pr-4">{k.name}</td>
                        <td className="mono py-2 pr-4 text-faint">{k.prefix}…</td>
                        <td className="mono py-2 pr-4 text-faint">
                          {new Date(k.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                        </td>
                        <td className="mono py-2 pr-4 text-faint">
                          {k.last_used_at
                            ? new Date(k.last_used_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
                            : "Never"}
                        </td>
                        <td className="py-2">
                          {k.revoked_at ? (
                            <span className="text-faint">Revoked</span>
                          ) : (
                            <form action={revokeApiKeyAction}>
                              <input type="hidden" name="id" value={k.id} />
                              <button className="text-danger hover:underline">Revoke</button>
                            </form>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
