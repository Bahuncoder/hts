import Link from "next/link";
import { redirect } from "next/navigation";
import { currentViewer } from "@/lib/auth";
import { listAlerts, unreadCount, diffStatus } from "@/lib/diff";
import { listWatched } from "@/lib/catalogues";
import { markAlertsReadAction } from "@/lib/actions";
import { Card } from "@/components/ui";

export const metadata = { title: "Alerts" };
export const dynamic = "force-dynamic";

export default async function AlertsPage() {
  const viewer = await currentViewer();
  if (!viewer) redirect("/login");

  const alerts = await listAlerts(viewer.account.id, 100);
  const unread = await unreadCount(viewer.account.id);
  const watched = await listWatched(viewer.account.id);
  const status = await diffStatus();

  return (
    <div className="space-y-7">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1.5">
          <h1 className="serif text-3xl tracking-tight">Alerts</h1>
          <p className="text-[15px] text-muted">
            Tariff actions naming a code you watch.{" "}
            {watched.length.toLocaleString()} codes watched
            {status?.last_run_at ? (
              <>
                {" "}
                · last checked{" "}
                <span className="nb">
                  {new Date(status.last_run_at).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                  })}
                </span>
              </>
            ) : null}
          </p>
        </div>
        {unread > 0 ? (
          <form action={markAlertsReadAction}>
            <button className="px-3 py-2 text-[14px] border border-rule text-muted">
              Mark {unread} read
            </button>
          </form>
        ) : null}
      </div>

      {watched.length === 0 ? (
        <Card>
          <p className="text-[15px] text-muted">
            You are not watching any codes yet. Save a catalogue from an{" "}
            <Link href="/audit" className="hover:underline text-accent">
              audit
            </Link>{" "}
            and every code in it is watched automatically.
          </p>
        </Card>
      ) : alerts.length === 0 ? (
        <Card>
          <p className="text-[15px] text-muted">
            {status?.last_run_at ? (
              <>
                No tariff action we have read names your codes as of the last
                check on{" "}
                {new Date(status.last_run_at).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                })}
                . That is the usual answer. We match Federal Register notices
                that cite HTS numbers, so a change published without naming a
                code would not appear here.
              </>
            ) : (
              <>
                Monitoring has not run yet, so an empty list does not mean
                nothing has changed. Alerts appear here after the first daily
                check.
              </>
            )}
          </p>
        </Card>
      ) : (
        <div className="space-y-3">
          {alerts.map((a) => (
            <Card key={a.id}>
              <div className="flex flex-wrap items-baseline gap-3">
                <span className="mono nb text-[12px] text-faint">
                  {a.publication_date}
                </span>
                <Link
                  href={`/hts/${a.hts}`}
                  className="mono nb text-[13px] font-medium hover:underline text-accent"
                >
                  {a.hts}
                </Link>
                {!a.read_at ? (
                  <span
                    className="text-[10px] font-semibold tracking-[0.08em]"
                    style={{
                      background: "var(--accent-soft)",
                      color: "var(--accent)",
                      padding: "2px 6px",
                    }}
                  >
                    NEW
                  </span>
                ) : null}
              </div>
              <a
                href={a.html_url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1.5 block font-medium hover:underline"
              >
                {a.title}
              </a>
            </Card>
          ))}
        </div>
      )}

      {watched.length > 0 ? (
        <div className="space-y-2 border-t pt-6 border-border">
          <h2 className="text-[15px] font-semibold">Watched codes</h2>
          <div className="flex flex-wrap gap-1.5">
            {watched.map((w) => (
              <Link
                key={`${w.digits}-${w.catalogue_id ?? "solo"}`}
                href={`/hts/${w.hts}`}
                className="mono nb px-2 py-1 text-[12px] hover:underline border border-border text-muted"

                title={w.catalogue_name ?? "watched directly"}
              >
                {w.hts}
              </Link>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
