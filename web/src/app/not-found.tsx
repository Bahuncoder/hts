import Link from "next/link";

export default function NotFound() {
  return (
    <div className="max-w-xl space-y-4">
      <h1 className="text-3xl font-semibold tracking-tight">Not found</h1>
      <p style={{ color: "var(--muted)" }}>
        That HTS code isn&rsquo;t in the current schedule. Codes change between
        editions — try searching by description instead.
      </p>
      <Link href="/classify" className="hover:underline" style={{ color: "var(--accent)" }}>
        Classify a product
      </Link>
    </div>
  );
}
