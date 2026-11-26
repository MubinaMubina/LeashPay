/** Announce one loading state while keeping decorative bars out of the accessibility tree. */
export function Skeleton({ label, variant = "lines" }: { label: string; variant?: "lines" | "plan" | "intro" | "receipt" }) {
  return (
    <div role="status" className={`skeleton skeleton-${variant}`}>
      <span className="sr-only">{label}</span>
      <div aria-hidden="true" className="sk-title" />
      {variant === "plan" && <div aria-hidden="true" className="sk-total" />}
      {[0, 1].map((row) => (
        <div aria-hidden="true" key={row} className="sk-row">
          <i /><i />{variant === "plan" && <i />}
        </div>
      ))}
      {variant === "plan" && <div aria-hidden="true" className="sk-checks" />}
      {(variant === "plan" || variant === "intro") && <div aria-hidden="true" className="sk-button" />}
    </div>
  );
}
