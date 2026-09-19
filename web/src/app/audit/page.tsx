import { PageHeader } from "@/components/PageHeader";
import AuditClient from "./AuditClient";
import { currentViewer } from "@/lib/auth";
import { LIMITS } from "@/lib/plans";

export const metadata = {
  title: "Catalogue duty audit — price your whole import exposure",
  description:
    "Upload a product catalogue and get an HTS code, duty rate and annual duty exposure for every SKU, with recoverable duty flagged.",
};

export const dynamic = "force-dynamic";

export default async function AuditPage() {
  const viewer = await currentViewer();
  return (
    <div className="space-y-8">
      <PageHeader eyebrow="Your import workspace" title="Catalogue audit" description="Turn your product list into a clear picture of duty exposure. Import a CSV, review the estimates, then save the codes you want to monitor." />
      <AuditClient signedIn={Boolean(viewer)} maxRows={(viewer ? LIMITS.account : LIMITS.anonymous).productsPerAudit} />
    </div>
  );
}
