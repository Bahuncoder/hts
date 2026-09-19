/** A labelled form control. The label is always visible — a placeholder is an
 *  example, not a name — and helper text is tied to the control through
 *  `aria-describedby` (`${id}-hint`) by the caller. */
export const inputClass =
  "w-full rounded-md border px-3 py-2 text-[15px] border-border bg-paper text-ink";

export function Field({
  id,
  label,
  hint,
  className = "",
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <label htmlFor={id} className="block text-[13px] font-medium">
        {label}
      </label>
      <div className="mt-1">{children}</div>
      {hint ? (
        <p id={`${id}-hint`} className="mt-1 text-[12px] text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** A group of related radio buttons with a visible legend. */
export function RadioGroup({
  legend,
  name,
  value,
  options,
  hint,
}: {
  legend: string;
  name: string;
  value: string;
  options: { value: string; label: string }[];
  hint?: string;
}) {
  return (
    <fieldset aria-describedby={hint ? `${name}-hint` : undefined}>
      <legend className="text-[13px] font-medium">{legend}</legend>
      <div className="mt-1 flex flex-wrap gap-x-5 gap-y-1">
        {options.map((o) => (
          <label key={o.value} className="flex items-center gap-2 text-[14px]">
            <input
              type="radio"
              name={name}
              value={o.value}
              defaultChecked={o.value === value}
              className="accent-[var(--accent)]"
            />
            {o.label}
          </label>
        ))}
      </div>
      {hint ? (
        <p id={`${name}-hint`} className="mt-1 text-[12px] text-muted">
          {hint}
        </p>
      ) : null}
    </fieldset>
  );
}
