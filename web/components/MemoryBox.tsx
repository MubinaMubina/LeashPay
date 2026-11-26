import type { PlanMemoryJson } from "@/lib/plan-progress";

/** "Living Brain: you last paid Linh …" reads as "You last paid Linh …" inside the Living Brain box. */
const withoutSource = (link: string) => {
  const text = link.replace(/^Living Brain:\s*/, "");
  return text.charAt(0).toUpperCase() + text.slice(1);
};

/** What the agent's memory (Living Brain) recalled before planning, how it connects to this plan, and whether saving works. */
export function MemoryBox({ memory }: { memory: PlanMemoryJson }) {
  const links = memory.available ? memory.links ?? [] : [];
  return (
    <div className={`depeg memory ${memory.available ? "" : "off"}`}>
      <div className="depeg-head">
        <span>{memory.available ? "Agent memory" : "Agent memory unavailable"}</span>
        <span className="depeg-meta">Living Brain</span>
      </div>
      {!memory.available && <p className="claim">{memory.reason}</p>}
      {links.length > 0 && (
        <>
          <p className="claim">Connected to this plan</p>
          <ul className="sources">{links.map((link) => <li key={link}>{withoutSource(link)}</li>)}</ul>
        </>
      )}
      {memory.available && memory.notes.length === 0 && <p className="claim">Nothing recalled for this message.</p>}
      {memory.available && memory.notes.length > 0 && (
        <>
          <p className="claim">Recalled before planning</p>
          <ul className="sources">
            {memory.notes.map((note, i) => (
              <li key={i}>
                <strong>{note.title}</strong>: {note.text}
              </li>
            ))}
          </ul>
        </>
      )}
      {memory.writeError && <p className="memory-warn">Saving new memories is failing: {memory.writeError}</p>}
    </div>
  );
}
