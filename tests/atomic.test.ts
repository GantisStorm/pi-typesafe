import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { writeOwnerOnlyAtomic } from "../src/atomic.js";

test("a symlink planted at the temp path is refused, not followed", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-typesafe-atomic-"));
  try {
    const path = join(dir, "record.json");
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "VICTIM", { mode: 0o644 });
    symlinkSync(victim, `${path}.${process.pid}.tmp`);
    writeOwnerOnlyAtomic(path, "NEW-RECORD");
    assert.equal(lstatSync(path).isSymbolicLink(), false, "the record must be a regular file, never a symlink");
    assert.equal(readFileSync(path, "utf8"), "NEW-RECORD");
    assert.equal(readFileSync(victim, "utf8"), "VICTIM", "the link target must not be overwritten");
    assert.equal(statSync(victim).mode & 0o777, 0o644, "the link target must keep its mode");
    assert.equal(statSync(path).mode & 0o777, 0o600, "the record stays owner-only");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a stale temp left behind is replaced instead of failing the write", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-typesafe-atomic-"));
  try {
    const path = join(dir, "record.json");
    writeFileSync(`${path}.${process.pid}.tmp`, "STALE", { mode: 0o600 });
    writeOwnerOnlyAtomic(path, "FRESH");
    assert.equal(readFileSync(path, "utf8"), "FRESH");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
