import AuditClient from "./AuditClient";
import { currentViewer } from "@/lib/auth";

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
      <div className="max-w-2xl space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">
          Catalogue audit
        </h1>
        <p className="text-muted">
          Paste or upload your catalogue. Every line gets a classification, the
          full duty stack for its origin, and a flag where a trade
          remedy&rsquo;s scope needs confirming. Leave the HTS column blank and
          it will be classified.
        </p>
      </div>
      <AuditClient signedIn={Boolean(viewer)} />
    </div>
  );
}
