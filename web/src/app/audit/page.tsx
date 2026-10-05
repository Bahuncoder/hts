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
    <div className="space-y-6">
      <AuditClient
        signedIn={Boolean(viewer)}
        maxRows={(viewer ? viewer.limits : LIMITS.anonymous).productsPerAudit}
        maxSavedCatalogues={viewer ? viewer.limits.savedCatalogues : 0}
      />
    </div>
  );
}
