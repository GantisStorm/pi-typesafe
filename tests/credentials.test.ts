import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { clearStoredApiKey, credentialsPath, keySituation, keySourceLabel, normalizeApiKey, readStoredApiKey, resolveApiKey, storeApiKey } from "../src/credentials.js";
import { createTypeSafe, TypeSafeIntegrationError } from "../src/index.js";

const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
const savedKey = process.env.TYPESAFE_API_KEY;
let agentDir: string;
const validKey = "ts_test_key_0123456789abcdef";

before(() => {
  agentDir = mkdtempSync(join(tmpdir(), "pi-typesafe-credentials-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
});
beforeEach(() => {
  delete process.env.TYPESAFE_API_KEY;
  clearStoredApiKey();
});
after(async () => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = savedKey;
  await rm(agentDir, { recursive: true, force: true });
});

test("credentials live under Pi's agent directory", () => {
  assert.equal(credentialsPath(), join(agentDir, "pi-typesafe", "auth.json"));
});

test("store, read, and clear with owner-only permissions", () => {
  assert.equal(resolveApiKey(), undefined);
  const path = storeApiKey(`  ${validKey}\n`);
  assert.equal(path, credentialsPath());
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(join(agentDir, "pi-typesafe")).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { apiKey: validKey });
  assert.deepEqual(resolveApiKey(), { key: validKey, source: "stored" });
  assert.equal(clearStoredApiKey(), true);
  assert.equal(clearStoredApiKey(), false);
  assert.equal(readStoredApiKey(), undefined);
});

test("environment variable takes precedence over the stored key", () => {
  storeApiKey(validKey);
  process.env.TYPESAFE_API_KEY = "env_key_0123456789abcdef";
  assert.deepEqual(resolveApiKey(), { key: "env_key_0123456789abcdef", source: "environment" });
});

test("implausible keys are rejected without saving", () => {
  for (const value of ["", "short", "has space in it 0123456789", "tab\tseparated0123456789", "ключ-with-non-ascii-0123456789", "x".repeat(513), 42, null]) {
    assert.throws(() => storeApiKey(value), (error: unknown) => error instanceof TypeSafeIntegrationError && error.code === "validation" && (String(value).length < 4 || !error.message.includes(String(value))));
  }
  assert.equal(readStoredApiKey(), undefined);
  assert.equal(normalizeApiKey(` ${validKey} `), validKey);
});

test("group- or world-readable credential files are refused", { skip: process.platform === "win32" }, () => {
  storeApiKey(validKey);
  chmodSync(credentialsPath(), 0o644);
  assert.throws(() => resolveApiKey(), (error: unknown) => error instanceof TypeSafeIntegrationError && error.code === "configuration" && /chmod 600/.test(error.message));
});

test("corrupt or unexpected files are treated as no key", () => {
  mkdirSync(join(agentDir, "pi-typesafe"), { recursive: true, mode: 0o700 });
  for (const content of ["not json", "[]", "{\"apiKey\": 5}", "{}"]) {
    writeFileSync(credentialsPath(), content, { mode: 0o600 });
    assert.equal(readStoredApiKey(), undefined);
  }
});

test("createTypeSafe uses the stored key and listModels verifies it without spending the request budget", async () => {
  storeApiKey(validKey);
  let authorized = false;
  const client = createTypeSafe({ maxRequests: 1, fetch: async (url, init) => {
    assert.equal(url, "https://api.typesafe.ai/v1/models");
    authorized = Object.values(Object.fromEntries(new Headers(init?.headers))).some(value => value.includes(validKey));
    return Response.json({ models: [{ name: "jev-latest", description: "", release_date: "2026-01-01" }, { name: 7 }] });
  } });
  assert.deepEqual(await client.listModels(), ["jev-latest"]);
  assert.ok(authorized);
  assert.equal(client.getUsage().requestsStarted, 0);
  assert.throws(() => { clearStoredApiKey(); createTypeSafe(); }, (error: unknown) => error instanceof TypeSafeIntegrationError && /\/typesafe login/.test(error.message));
});

test("invalid keys fail verification with a safe message", async () => {
  const client = createTypeSafe({ apiKey: validKey, fetch: async () => Response.json({ detail: "secret-body" }, { status: 401 }) });
  await assert.rejects(client.listModels(), (error: unknown) => error instanceof TypeSafeIntegrationError && error.status === 401 && !error.message.includes("secret-body"));
});

test("keySituation is total and names every kind", { skip: process.platform === "win32" }, () => {
  assert.deepEqual(keySituation(), { kind: "missing" });

  storeApiKey(validKey);
  assert.deepEqual(keySituation(), { kind: "stored", key: validKey, path: credentialsPath() });

  chmodSync(credentialsPath(), 0o644);
  const situation = keySituation();
  assert.ok(situation.kind === "unusable");
  assert.equal(situation.path, credentialsPath());
  assert.match(situation.reason, /chmod 600/);
  assert.throws(() => resolveApiKey(), (error: unknown) => error instanceof TypeSafeIntegrationError && error.message === situation.reason);

  process.env.TYPESAFE_API_KEY = `  ${validKey}  `;
  assert.deepEqual(keySituation(), { kind: "environment", key: validKey, keyEnv: "TYPESAFE_API_KEY" });

  // Environment values are trusted as-is; a wrong key fails at the API with its own advice.
  process.env.TYPESAFE_API_KEY = "short";
  assert.deepEqual(keySituation(), { kind: "environment", key: "short", keyEnv: "TYPESAFE_API_KEY" });
});

test("keySituation for another backend reads only that backend's variable, never the TypeSafe store", () => {
  const savedOpenRouter = process.env.OPENROUTER_API_KEY;
  try {
    delete process.env.OPENROUTER_API_KEY;
    storeApiKey(validKey);
    process.env.TYPESAFE_API_KEY = validKey;
    // A stored or TypeSafe-environment key is not an OpenRouter key.
    assert.deepEqual(keySituation("openrouter"), { kind: "missing" });
    assert.equal(resolveApiKey("openrouter"), undefined);

    process.env.OPENROUTER_API_KEY = "  sk-or-test-0123456789abcdef  ";
    const situation = keySituation("openrouter");
    assert.deepEqual(situation, { kind: "environment", key: "sk-or-test-0123456789abcdef", keyEnv: "OPENROUTER_API_KEY" });
    assert.equal(keySourceLabel(situation), "OPENROUTER_API_KEY");
    assert.deepEqual(resolveApiKey("openrouter"), { key: "sk-or-test-0123456789abcdef", source: "environment" });
    // The OpenRouter variable does not leak into the TypeSafe resolution either.
    delete process.env.TYPESAFE_API_KEY;
    assert.equal(keySituation().kind, "stored");
    assert.throws(() => keySituation("bogus" as never), (error: unknown) => error instanceof TypeSafeIntegrationError && error.code === "configuration" && /Unknown judgment backend/.test(error.message));
  } finally {
    if (savedOpenRouter === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = savedOpenRouter;
  }
});

test("keySourceLabel names each source", () => {
  assert.equal(keySourceLabel({ kind: "environment", key: "k" }), "TYPESAFE_API_KEY");
  assert.equal(keySourceLabel({ kind: "environment", key: "k", keyEnv: "OPENROUTER_API_KEY" }), "OPENROUTER_API_KEY");
  assert.equal(keySourceLabel({ kind: "stored", key: "k", path: "/tmp/auth.json" }), "/typesafe login");
  assert.equal(keySourceLabel({ kind: "missing" }), "no key");
  assert.equal(keySourceLabel({ kind: "unusable", path: "/tmp/auth.json", reason: "r" }), "unusable key");
});

test("an endpoint keyEnv that names an Object.prototype member is missing, not a crash", () => {
  // process.env inherits Object.prototype, so reading `toString` used to resolve a function and throw.
  assert.deepEqual(keySituation({ label: "Probe", host: "https://probe.example.com", keyEnv: "toString" }), { kind: "missing" });
  assert.deepEqual(keySituation({ label: "Probe", host: "https://probe.example.com", keyEnv: "valueOf" }), { kind: "missing" });
  process.env.PROBE_JEV_KEY = `  ${validKey}  `;
  try {
    assert.deepEqual(keySituation({ label: "Probe", host: "https://probe.example.com", keyEnv: "PROBE_JEV_KEY" }), { kind: "environment", key: validKey, keyEnv: "PROBE_JEV_KEY" });
  } finally {
    delete process.env.PROBE_JEV_KEY;
  }
});

test("a key store that cannot finish removes its temp file instead of leaving the key behind", () => {
  const storeDir = join(agentDir, "pi-typesafe");
  mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  // Renaming a file onto a directory cannot succeed, so the failure happens after the temp file is written.
  mkdirSync(credentialsPath());
  try {
    assert.throws(() => storeApiKey(validKey), (error: unknown) => error instanceof TypeSafeIntegrationError && error.code === "configuration");
    assert.deepEqual(readdirSync(storeDir).filter(name => name.endsWith(".tmp")), []);
  } finally {
    rmSync(credentialsPath(), { recursive: true, force: true });
  }
});

test("an unremovable stored key is a classified error that leaves the key in place", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
  storeApiKey(validKey);
  const storeDir = join(agentDir, "pi-typesafe");
  chmodSync(storeDir, 0o500);
  try {
    assert.throws(() => clearStoredApiKey(), (error: unknown) => error instanceof TypeSafeIntegrationError && error.code === "configuration" && /Could not remove/.test(error.message));
    assert.equal(readStoredApiKey(), validKey);
  } finally {
    chmodSync(storeDir, 0o700);
  }
  assert.equal(clearStoredApiKey(), true);
});

test("a key store in an unwritable directory is a classified error that leaves the old key whole", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
  const storeDir = join(agentDir, "pi-typesafe");
  const replacement = "ts_test_key_fedcba9876543210";
  storeApiKey(validKey);
  assert.equal(statSync(credentialsPath()).mode & 0o777, 0o600);
  const before = readFileSync(credentialsPath(), "utf8");
  chmodSync(storeDir, 0o500);
  try {
    assert.throws(() => storeApiKey(replacement), (error: unknown) => error instanceof TypeSafeIntegrationError && error.code === "configuration" && /Could not write/.test(error.message));
  } finally {
    chmodSync(storeDir, 0o700);
  }
  assert.equal(readFileSync(credentialsPath(), "utf8"), before, "a failed store must not truncate or half-write the key file");
  assert.deepEqual(readdirSync(storeDir).filter(name => name.endsWith(".tmp")), []);
  assert.equal(readStoredApiKey(), validKey);
  // Writable again: the same call replaces the key in one step, owner-only.
  storeApiKey(replacement);
  assert.equal(readStoredApiKey(), replacement);
  assert.equal(statSync(credentialsPath()).mode & 0o777, 0o600);
});

test("the key-length boundary is enforced before anything is saved", () => {
  const rejected = (error: unknown) => error instanceof TypeSafeIntegrationError && error.code === "validation";
  assert.throws(() => storeApiKey("k".repeat(15)), rejected);
  assert.equal(readStoredApiKey(), undefined, "a rejected key must not be written");
  assert.equal(storeApiKey("k".repeat(16)), credentialsPath());
  assert.equal(readStoredApiKey(), "k".repeat(16));
  assert.equal(storeApiKey("k".repeat(512)), credentialsPath());
  assert.throws(() => storeApiKey("k".repeat(513)), rejected);
  assert.equal(readStoredApiKey(), "k".repeat(512), "a rejected key must leave the stored one whole");
});

test("a writer-less FIFO at the key path is refused instead of blocking", { skip: process.platform === "win32" }, () => {
  mkdirSync(join(agentDir, "pi-typesafe"), { recursive: true, mode: 0o700 });
  const path = credentialsPath();
  const made = spawnSync("mkfifo", [path], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr || "mkfifo is required for this test");
  // Owner-only so the mode check passes and the read itself is what must refuse the FIFO. Opening it blocks forever, so
  // the read runs in a child process whose timeout bounds it: a regression shows up as a killed process instead of a
  // hung suite. The child needs `await import` rather than a static import because its specifier is resolved at run
  // time inside the spawned script, and the agent directory is set there too, after the module reads its own default.
  chmodSync(path, 0o600);
  try {
    const source = `process.env.PI_CODING_AGENT_DIR = ${JSON.stringify(agentDir)};
const { readStoredApiKey } = await import(${JSON.stringify(resolve("src/credentials.ts"))});
try { process.stdout.write("key:" + String(readStoredApiKey())); }
catch (error) { process.stdout.write("refused:" + error.code + ":" + error.message); }`;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
      cwd: process.cwd(),
      timeout: 20_000,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || `the read did not return (signal ${result.signal})`);
    assert.match(String(result.stdout), /^refused:configuration:.*not a regular file/);
  } finally {
    rmSync(path, { force: true });
  }
});
