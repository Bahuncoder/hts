"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/** Search and sort for a saved catalogue's lines. It works like the audit's
 *  controls: results follow the typing and the choice straight away, with no
 *  Apply step. Each change moves the page to the matching URL, so the view
 *  can be bookmarked and shared. */
export default function LineControls({
  basePath, show, sort, q,
}: {
  basePath: string;
  show: string;
  sort: string;
  /** The search term the page was rendered with. */
  q: string;
}) {
  const router = useRouter();
  const [term, setTerm] = useState(q);
  const [order, setOrder] = useState(sort);

  useEffect(() => {
    // Nothing to do when the page already shows these controls' values.
    if (term.trim() === q.trim() && order === sort) return;
    const timer = setTimeout(() => {
      const params = new URLSearchParams();
      if (show !== "all") params.set("show", show);
      if (term.trim()) params.set("q", term.trim());
      if (order !== "unresolved") params.set("sort", order);
      const qs = params.toString();
      router.replace(`${basePath}${qs ? `?${qs}` : ""}`, { scroll: false });
    }, 250);
    return () => clearTimeout(timer);
  }, [term, order, show, sort, q, basePath, router]);

  return (
    <form
      role="search"
      className="flex flex-wrap items-end gap-3"
      onSubmit={(e) => e.preventDefault()}
    >
      <label className="min-w-[16rem] flex-1 text-[13px]">
        Search
        <input
          data-search
          type="search"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          className="field-control mt-1 block w-full"
          placeholder="SKU, description, origin, or HTS code"
        />
      </label>
      <label className="text-[13px]">
        Sort
        <select
          value={order}
          onChange={(e) => setOrder(e.target.value)}
          className="field-control mt-1 block w-full"
        >
          <option value="unresolved">Needs attention first</option>
          <option value="original">Original row order</option>
          <option value="duty">Highest duty first</option>
          <option value="value">Highest value first</option>
        </select>
      </label>
    </form>
  );
}
