import type { PlanMemoryJson } from "@/lib/plan-progress";

/** What the agent's memory (Living Brain) recalled before planning, and whether saving works. */
export function MemoryBox({ memory }: { memory: PlanMemoryJson }) {
  return (
    <div className={`depeg memory ${memory.available ? "" : "off"}`}>
      <div className="depeg-head">
        <span>{memory.available ? "Agent memory" : "Agent memory unavailable"}</span>
        <span className="depeg-meta">Living Brain</span>
      </div>
      {!memory.available && <p className="claim">{memory.reason}</p>}
      {memory.available && memory.notes.length === 0 && <p className="claim">Nothing recalled for this message.</p>}
      {memory.available && memory.notes.length > 0 && (
        <ul className="sources">
          {memory.notes.map((note, i) => (
            <li key={i}>
              <strong>{note.title}</strong>: {note.text.length > 220 ? `${note.text.slice(0, 220)}…` : note.text}
            </li>
          ))}
        </ul>
      )}
      {memory.writeError && <p className="memory-warn">Saving new memories is failing: {memory.writeError}</p>}
    </div>
  );
}
