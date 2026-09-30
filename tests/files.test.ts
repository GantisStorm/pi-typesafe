import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readJudgmentFiles, registerFileEvaluation } from "../src/files.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TypeSafe } from "../src/client.js";

async function workspace(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "jev-file-"));
  try { await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("file screening preserves explicitly selected UTF-8 source in input order", async () => {
  await workspace(async root => {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/a.ts"), "export const greeting = 'héllo';\n");
    await writeFile(join(root, "b.py"), "def parse(): pass\n");
    const files = await readJudgmentFiles(root, ["src/a.ts", "b.py"]);
    assert.deepEqual(files, [
      { path: "src/a.ts", content: "export const greeting = 'héllo';\n" },
      { path: "b.py", content: "def parse(): pass\n" },
    ]);
  });
});

test("rejects parent traversal, absolute paths, secrets and dependency trees", async () => {
  await workspace(async root => {
    for (const path of ["../outside.ts", join(root, "a.ts"), ".env", ".env.template", "PROD_CREDS.md", ".git/config", "node_modules/lib.ts", "settings.local.json", "auth.json"]) {
      await assert.rejects(readJudgmentFiles(root, [path]), /permitted|source/);
    }
  });
});

test("rejects symlink leaves, symlink parents and hardlinked sources", async () => {
  await workspace(async root => {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/real.ts"), "export const value = 1;\n");
    await symlink(join(root, "src/real.ts"), join(root, "alias.ts"));
    await symlink(join(root, "src"), join(root, "alias-dir"));
    await assert.rejects(readJudgmentFiles(root, ["alias.ts"]), /Symlink/);
    await assert.rejects(readJudgmentFiles(root, ["alias-dir/real.ts"]), /Symlink/);
    await link(join(root, "src/real.ts"), join(root, "hard.ts"));
    await assert.rejects(readJudgmentFiles(root, ["hard.ts"]), /non-hardlinked/);
  });
});

test("rejects oversized, binary and invalid UTF-8 inputs rather than truncating", async () => {
  await workspace(async root => {
    await writeFile(join(root, "big.ts"), "x".repeat(16_385));
    await writeFile(join(root, "binary.ts"), Buffer.from([65, 0, 66]));
    await writeFile(join(root, "invalid.ts"), Buffer.from([0xff, 0xfe]));
    await assert.rejects(readJudgmentFiles(root, ["big.ts"]), /exceeds/);
    await assert.rejects(readJudgmentFiles(root, ["binary.ts"]), /Binary/);
    await assert.rejects(readJudgmentFiles(root, ["invalid.ts"]), /UTF-8/);
  });
});

test("rejects credential-shaped content and does not echo it into errors", async () => {
  await workspace(async root => {
    const secret = `user_${"A".repeat(40)}`;
    await writeFile(join(root, "credential.ts"), `const key = '${secret}';`);
    await assert.rejects(readJudgmentFiles(root, ["credential.ts"]), error => {
      assert.match(String(error), /Potential credential/);
      assert.equal(String(error).includes(secret), false);
      return true;
    });
  });
});

test("normalised duplicates, excess file counts and cancellation are rejected", async () => {
  await workspace(async root => {
    await writeFile(join(root, "a.ts"), "export const x = 1;");
    await assert.rejects(readJudgmentFiles(root, ["a.ts", "./a.ts"]), /Duplicate/);
    await assert.rejects(readJudgmentFiles(root, []), /Select/);
    await assert.rejects(readJudgmentFiles(root, Array(9).fill("a.ts")), /Select/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(readJudgmentFiles(root, ["a.ts"], controller.signal), /cancelled/);
  });
});

test("an unsafe later file prevents all provider submissions; disabled consent prevents reads", async () => {
  await workspace(async root => {
    await writeFile(join(root, "safe.ts"), "export const x = 1;");
    await writeFile(join(root, "unsafe.ts"), `const key = 'user_${"B".repeat(40)}';`);
    let execute: (...args: unknown[]) => Promise<unknown> = async () => { throw new Error("not registered"); };
    const pi = { registerTool(definition: { execute: typeof execute }) { execute = definition.execute; } } as unknown as ExtensionAPI;
    let submissions = 0;
    const client = { async evaluateMany() { submissions++; throw new Error("unsafe submission"); } } as unknown as TypeSafe;
    let enabled = true;
    registerFileEvaluation(pi, { enabled: () => enabled, client: () => client, host: "api.commandcode.ai" });
    const params = { paths: ["safe.ts", "unsafe.ts"], questions: { relevant: { type: "noul", instructions: "Is state.file.content relevant?" } } };
    await assert.rejects(execute("id", params, undefined, undefined, { cwd: root }), /Potential credential/);
    assert.equal(submissions, 0);
    enabled = false;
    await assert.rejects(execute("id", { ...params, paths: ["does-not-exist.ts"] }, undefined, undefined, { cwd: root }), /disabled/);
    assert.equal(submissions, 0);
  });
});
