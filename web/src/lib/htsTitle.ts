/** A readable title for an HTS line.
 *
 *  The tariff's own description of a statistical line is often only a
 *  fragment — "Men's (338)", "Other" — that means something only beside its
 *  parents. When it is short, the title is built from the nearest two
 *  ancestors in the classification path and the line's own wording is kept as
 *  a subtitle. A description that stands on its own is used as it is.
 */

const PATH_SEPARATOR = " > ";
/** The trailing statistical-category number the USITC appends: "(338)". */
const STAT_SUFFIX = /\s*\(\d{1,4}\)\s*$/;
/** Below this many characters (once the suffix is removed) a description is
 *  treated as a fragment. */
const FRAGMENT_LENGTH = 25;
const SEGMENT_MAX = 70;

/** The path as its segments, root first, without the tariff's trailing colons. */
export function pathSegments(fullPath: string): string[] {
  return fullPath
    .split(PATH_SEPARATOR)
    .map((s) => s.trim().replace(/:$/, "").trim())
    .filter(Boolean);
}

function shorten(s: string, max = SEGMENT_MAX): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max).replace(/\s+\S*$/, "");
  return `${cut || s.slice(0, max)}…`;
}

export function isFragment(description: string): boolean {
  return description.replace(STAT_SUFFIX, "").trim().length < FRAGMENT_LENGTH;
}

export function htsTitle(
  description: string,
  fullPath: string,
): { title: string; subtitle: string | null } {
  if (!isFragment(description)) return { title: description, subtitle: null };
  const segments = pathSegments(fullPath);
  // The path normally ends with the line's own description; it is not one of
  // its own ancestors.
  const last = segments.at(-1);
  const ancestors =
    last !== undefined && last === description.replace(/:$/, "").trim()
      ? segments.slice(0, -1)
      : segments;
  const nearest = ancestors.slice(-2).map((s) => shorten(s));
  if (!nearest.length) return { title: description, subtitle: null };
  return { title: nearest.join(" › "), subtitle: description };
}
