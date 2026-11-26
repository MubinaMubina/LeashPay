"use client";

export function TabList<T extends string>({ names, selected, onSelect, label, className, prefix = "", shortNames }: {
  names: readonly T[];
  selected: T;
  onSelect: (name: T) => void;
  label: string;
  className: string;
  prefix?: string;
  shortNames?: Partial<Record<T, string>>;
}) {
  return <div className={className} role="tablist" aria-label={label}>
    {names.map((name, index) => <button type="button" key={name} role="tab" id={`${prefix}tab-${index}`}
      aria-label={shortNames?.[name] ? name : undefined} aria-selected={selected === name}
      aria-controls={`${prefix}panel-${index}`} tabIndex={selected === name ? 0 : -1}
      onClick={() => onSelect(name)}
      onKeyDown={event => {
        let next: number;
        switch (event.key) {
          case "Home": next = 0; break;
          case "End": next = names.length - 1; break;
          case "ArrowRight": next = (index + 1) % names.length; break;
          case "ArrowLeft": next = (index + names.length - 1) % names.length; break;
          default: return;
        }
        event.preventDefault();
        onSelect(names[next]);
        document.getElementById(`${prefix}tab-${next}`)?.focus();
      }}>{shortNames?.[name] ?? name}</button>)}
  </div>;
}
