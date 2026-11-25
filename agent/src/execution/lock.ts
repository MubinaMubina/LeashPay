import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 only checks that the process exists
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"; // exists, owned by someone else
  }
}

/**
 * Makes this process the only agent server using `dir`. Two servers on one data
 * folder would each keep their own copy of the journal and their own "one plan at a
 * time" lock, so neither could see what the other sent. A lock left behind by a
 * server that crashed is taken over. Returns a function that releases the lock.
 */
export function lockDataDir(dir: string): () => void {
  mkdirSync(dir, { recursive: true, mode: 0o700 }); // the data folder is for the agent's account only
  const file = path.join(dir, "server.lock");
  const me = String(process.pid);
  try {
    writeFileSync(file, me, { flag: "wx", mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const holder = Number.parseInt(readFileSync(file, "utf8"), 10);
    if (Number.isInteger(holder) && holder !== process.pid && isRunning(holder)) {
      // Not "use another DATA_DIR": a fresh folder has an empty journal, which would forget
      // every payment already sent.
      throw new Error(
        `Another agent server (process ${holder}) is already using ${dir}. Stop it first. ` +
          `If no agent server is running (process ${holder} is something else now), delete ${file} and start again.`,
      );
    }
    writeFileSync(file, me, { mode: 0o600 }); // left behind by a server that is no longer running
  }

  const release = () => {
    try {
      if (readFileSync(file, "utf8") === me) unlinkSync(file);
    } catch {
      // already gone
    }
  };
  process.once("exit", release);
  return release;
}
