import { chmodSync, closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { TypeSafeIntegrationError } from "./errors.js";

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
  // O_CREAT|O_EXCL refuses any pre-existing entry and O_NOFOLLOW refuses to follow a symlink, so a link planted at the
  // temp path can never redirect the write, the chmod, or the rename to another file.
  const exclusive = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  const writeTemporary = (): void => {
    const descriptor = openSync(temporary, exclusive, 0o600);
    try { writeFileSync(descriptor, contents); } finally { closeSync(descriptor); }
  };
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      writeTemporary();
    } catch (error) {
      // A leftover temp from a crashed process that reused this pid is ours to replace. Unlinking a symlink removes the
      // link (never its target), and the exclusive retry still refuses a link planted between the two calls.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ELOOP") throw error;
      rmSync(temporary, { force: true });
      writeTemporary();
    }
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch { /* best-effort cleanup only */ }
    throw error;
  }
}

/**
 * Read a small record without ever blocking: the open is non-blocking and the descriptor's own stat refuses anything
 * that is not a regular file (FIFO, socket, device, directory) before a single byte is read, so a planted path cannot
 * stall the key store, the auth record, or the usage ledger. Symlinks are still followed, so a store managed from a
 * dotfiles directory keeps working.
 *
 * Internal: not re-exported from index.ts.
 */
export function readRegularFile(path: string): string {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!fstatSync(descriptor).isFile()) {
      throw new TypeSafeIntegrationError("configuration", `Refusing to read ${path}: it is not a regular file.`);
    }
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}
