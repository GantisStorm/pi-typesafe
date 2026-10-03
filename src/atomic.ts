import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Replace `path` with `contents` in one step: a same-directory temporary file written owner-only, then a rename that
 * either lands whole or leaves any previous file untouched. Throws on failure after removing the temporary file, so a
 * failed write never leaves a partial, other-user-readable, or orphaned record behind — the invariant the key store,
 * the auth record, and the usage ledger all need. Callers decide whether a failure is fatal.
 *
 * Internal: not re-exported from index.ts. A consumer never writes these files directly.
 */
export function writeOwnerOnlyAtomic(path: string, contents: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, contents, { mode: 0o600, flag: "w" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch { /* best-effort cleanup only */ }
    throw error;
  }
}
