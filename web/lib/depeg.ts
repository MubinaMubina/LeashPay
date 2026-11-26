/** The owner's depeg limit as saved in this browser, capped to the slider; null when there is none to use. */
export function parseStoredThreshold(raw: string | null, max: number): number | null {
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.min(value, max);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "26 Nov 06:30 UTC", the way the agent's signed sentence states the reading's time. */
export function readingTime(iso: string): string {
  const at = new Date(iso);
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.toISOString().slice(11, 16)} UTC`;
}

/** Cournot's probability as the owner reads it, to 0.01% (the agent decides on the same value). */
export const percent = (probability: number) => `${Math.round(probability * 10_000) / 100}%`;
