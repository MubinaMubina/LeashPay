/** Announce one loading state while keeping decorative bars out of the accessibility tree. */
export function Skeleton({ label, variant = "lines" }: { label: string; variant?: "lines" | "plan" | "intro" | "receipt" | "recipients" | "history" | "runway" }) {
  if (variant === "history") return <div role="status">
    <span className="sr-only">{label}</span>
    {[0, 1, 2].map(i => <div key={i} className="payment-row sk-person" aria-hidden="true">
      <i className="payment-arrow" /><div><i className="sk-name" /><i className="sk-location" /></div><i className="sk-amount" />
    </div>)}
  </div>;
  if (variant === "runway") return <div className="skeleton skeleton-runway" role="status">
    <span className="sr-only">{label}</span>
    <i className="sk-title" aria-hidden="true" />
    <div className="runway-balances" aria-hidden="true">{[0, 1].map(i =>
      <div key={i}><i className="sk-title" /><i className="sk-row" /></div>)}</div>
  </div>;
  if (variant === "recipients") {
    return (
      <div role="status" className="directory-skeleton">
        <span className="sr-only">{label}</span>
        {Array.from({ length: 10 }, (_, i) => (
          <div key={i} aria-hidden="true" className="person sk-person">
            <div><i className="sk-name" /><i className="sk-location" /></div>
            <i className="cap-loading" /><i className="sk-remove" />
          </div>
        ))}
      </div>
    );
  }
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
