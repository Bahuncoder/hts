import { failureCopy, type Failure } from "@/lib/api";

/** What a failed engine call looks like to a customer.
 *
 *  One place, so "the data service is down" reads the same on every page and
 *  never tells a visitor to run an operator job. `retryHref` should reload the
 *  same URL with the visitor's inputs intact. */
export function FailureNotice({
  failure,
  retryHref,
  subject,
}: {
  failure: Failure;
  retryHref?: string;
  /** What was being fetched, for the title: "the duty estimate". */
  subject?: string;
}) {
  const copy = failureCopy(failure);
  return (
    <div
      role="alert"
      className="max-w-2xl rounded-lg border p-5 border-caution bg-caution-soft text-caution-ink"
    >
      <p className="font-medium">
        {subject && failure.kind === "unavailable"
          ? `${subject[0].toUpperCase()}${subject.slice(1)} is temporarily unavailable`
          : copy.title}
      </p>
      <p className="mt-1 text-[14px]">{copy.body}</p>
      {copy.retryable && retryHref ? (
        <a
          href={retryHref}
          className="mt-3 inline-block rounded-md border px-3 py-1.5 text-[14px] font-medium border-caution"
        >
          Try again
        </a>
      ) : null}
    </div>
  );
}
