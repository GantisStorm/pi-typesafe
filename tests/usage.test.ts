import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_USD_PER_MTOK, capsFromEnvironment, estimateUsd, localDay, mergeCaps, openUsageLedger, usagePath,
} from "../src/usage.js";

const workspace = mkdtempSync(join(tmpdir(), "pi-typesafe-usage-"));
const ledgerPath = (name: string) => join(workspace, `${name}.json`);
const at = (day: number, hour = 12) => new Date(2026, 0, day, hour);

test("a ledger counts requests, tokens, and failures, and prices input tokens only", () => {
  const ledger = openUsageLedger({ path: ledgerPath("counts"), now: at.bind(null, 1) });
  assert.deepEqual(ledger.today(), { requestsStarted: 0, requestsSucceeded: 0, requestsFailed: 0, inputTokens: 0, outputTokens: 0, day: "2026-01-01", estimatedUsd: 0 });
  ledger.recordStart();
  ledger.recordSuccess(42, 7);
  ledger.recordStart();
  ledger.recordFailure();
  const today = ledger.today();
  assert.deepEqual({ ...today, estimatedUsd: undefined }, { requestsStarted: 2, requestsSucceeded: 1, requestsFailed: 1, inputTokens: 42, outputTokens: 7, day: "2026-01-01", estimatedUsd: undefined });
  // Output tokens are free; only input tokens carry a price.
  assert.equal(today.estimatedUsd, estimateUsd(42, DEFAULT_USD_PER_MTOK));
});

test("totals survive a new ledger instance, so a restart does not reset the day", () => {
  const path = ledgerPath("persist");
  const first = openUsageLedger({ path, now: at.bind(null, 2) });
  first.recordStart();
  first.recordSuccess(1_000, 0);
  const second = openUsageLedger({ path, now: at.bind(null, 2) });
  assert.equal(second.today().requestsStarted, 1);
  assert.equal(second.today().inputTokens, 1_000);
  assert.equal(second.today().estimatedUsd, estimateUsd(1_000, DEFAULT_USD_PER_MTOK));
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("the day rolls over on the local date and old days are kept", () => {
  let day = 3;
  const path = ledgerPath("rollover");
  const ledger = openUsageLedger({ path, now: () => at(day) });
  ledger.recordStart();
  ledger.recordSuccess(500, 0);
  day = 4;
  assert.equal(ledger.today().day, "2026-01-04");
  assert.equal(ledger.today().requestsStarted, 0);
  assert.equal(ledger.today().inputTokens, 0);
  ledger.recordStart();
  const file = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(file.days["2026-01-03"].inputTokens, 500);
  assert.equal(file.days["2026-01-04"].requestsStarted, 1);
});

test("each cap stops the next request and names itself", () => {
  const counting = openUsageLedger({ path: ledgerPath("cap-requests"), now: at.bind(null, 5) });
  const requests = { maxRequestsPerDay: 1 };
  assert.equal(counting.blocked(requests), undefined);
  counting.recordStart();
  assert.deepEqual(counting.blocked(requests), { cap: "requestsPerDay", limit: 1, used: 1, day: "2026-01-05" });

  const tokens = openUsageLedger({ path: ledgerPath("cap-tokens"), now: at.bind(null, 5) });
  const tokenCap = { maxInputTokensPerDay: 100 };
  tokens.recordSuccess(100, 0);
  assert.equal(tokens.blocked(tokenCap)?.cap, "inputTokensPerDay");

  const usd = openUsageLedger({ path: ledgerPath("cap-usd"), now: at.bind(null, 5), usdPerMTok: 1_000_000 });
  const usdCap = { maxUsdPerDay: 0.5 };
  usd.recordSuccess(1, 0);
  assert.equal(usd.blocked(usdCap)?.cap, "usdPerDay");
  assert.equal(usd.blocked(usdCap)?.used, 1);
  // The caps belong to the caller: the same totals block under one cap and pass under another.
  assert.equal(usd.blocked({ maxUsdPerDay: 10 }), undefined);
});

test("caps come from the environment without ever raising the explicit cap", () => {
  const environment = capsFromEnvironment({ PI_TYPESAFE_MAX_REQUESTS_PER_DAY: "500", PI_TYPESAFE_MAX_USD_PER_DAY: "2.5", PI_TYPESAFE_MAX_INPUT_TOKENS_PER_DAY: "nonsense" });
  assert.deepEqual(environment, { maxRequestsPerDay: 500, maxUsdPerDay: 2.5 });
  assert.deepEqual(mergeCaps({ maxRequests: 20, maxUsdPerDay: 1 }, environment), { maxRequests: 20, maxRequestsPerDay: 500, maxUsdPerDay: 1 });
  assert.deepEqual(mergeCaps({}, {}), {});
  assert.deepEqual(capsFromEnvironment({}), {});
});

test("a corrupt, unreadable, or foreign ledger never blocks a request", () => {
  const path = ledgerPath("corrupt");
  writeFileSync(path, "{ not json");
  const ledger = openUsageLedger({ path, now: at.bind(null, 6) });
  assert.equal(ledger.today().requestsStarted, 0);
  ledger.recordStart();
  assert.equal(openUsageLedger({ path, now: at.bind(null, 6) }).today().requestsStarted, 1);
  writeFileSync(path, JSON.stringify({ version: 1, days: { "2026-01-06": { requestsStarted: "many" }, notADay: {} } }));
  assert.equal(openUsageLedger({ path, now: at.bind(null, 6) }).today().requestsStarted, 0);
});

test("the default usage path sits with the key store", () => {
  const saved = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = workspace;
  try {
    assert.equal(usagePath(), join(workspace, "pi-typesafe", "usage.json"));
    assert.equal(localDay(at(7)), "2026-01-07");
  } finally {
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved;
  }
});

test("a non-finite price falls back to the default instead of poisoning estimates and caps", () => {
  const ledger = openUsageLedger({ path: ledgerPath("price"), now: at.bind(null, 8), usdPerMTok: Infinity });
  ledger.recordSuccess(1_000, 0);
  assert.equal(ledger.usdPerMTok, DEFAULT_USD_PER_MTOK);
  assert.equal(ledger.today().estimatedUsd, estimateUsd(1_000, DEFAULT_USD_PER_MTOK));
  // Infinity would have reported the USD cap as reached for a fraction of a cent.
  assert.equal(ledger.blocked({ maxUsdPerDay: 1 }), undefined);
});

test("an unwritable ledger directory is tolerated, and the last complete file survives", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
  const dir = join(workspace, "unwritable");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "usage.json");
  const ledger = openUsageLedger({ path, now: at.bind(null, 9) });
  ledger.recordStart();
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const before = readFileSync(path, "utf8");
  chmodSync(dir, 0o500);
  try {
    // The temp file cannot even be created, so the write fails while the previous record stays whole on disk.
    ledger.recordStart();
    ledger.recordSuccess(10, 0);
  } finally {
    chmodSync(dir, 0o700);
  }
  assert.equal(readFileSync(path, "utf8"), before, "a failed write must not truncate or half-write the ledger");
  assert.deepEqual(readdirSync(dir).filter(name => name.endsWith(".tmp")), []);
  assert.equal(openUsageLedger({ path, now: at.bind(null, 9) }).today().requestsStarted, 1);
  openUsageLedger({ path, now: at.bind(null, 9) }).recordStart();
  assert.equal(openUsageLedger({ path, now: at.bind(null, 9) }).today().requestsStarted, 2);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("two processes over one path both keep their increments", () => {
  const path = ledgerPath("two-processes");
  // Both open the same (empty) file before either writes, which is the shape a clobbering writer loses to.
  const first = openUsageLedger({ path, now: at.bind(null, 10) });
  const second = openUsageLedger({ path, now: at.bind(null, 10) });
  first.recordStart();
  first.recordSuccess(100, 5);
  second.recordStart();
  second.recordSuccess(7, 0);
  const file = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(file.days["2026-01-10"], { requestsStarted: 2, requestsSucceeded: 2, requestsFailed: 0, inputTokens: 107, outputTokens: 5 });
});

test("a rollover in one process keeps the other process's earlier day", () => {
  const path = ledgerPath("two-process-rollover");
  let day = 11;
  const first = openUsageLedger({ path, now: at.bind(null, 11) });
  const second = openUsageLedger({ path, now: () => at(day) });
  first.recordStart();
  first.recordSuccess(50, 0);
  day = 12;
  second.recordStart();
  const file = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(file.days["2026-01-11"].requestsStarted, 1);
  assert.equal(file.days["2026-01-11"].inputTokens, 50);
  assert.equal(file.days["2026-01-12"].requestsStarted, 1);
  // The clock moved on in one process only; the day that is no longer in its memory stays whole on disk.
  second.recordSuccess(3, 0);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).days["2026-01-11"].inputTokens, 50);
});

test("a corrupt or missing ledger mid-life still records the pending deltas", () => {
  const corruptPath = ledgerPath("mid-life-corrupt");
  const corrupt = openUsageLedger({ path: corruptPath, now: at.bind(null, 13) });
  writeFileSync(corruptPath, "{ not json");
  corrupt.recordStart();
  corrupt.recordSuccess(9, 2);
  assert.deepEqual(JSON.parse(readFileSync(corruptPath, "utf8")).days["2026-01-13"],
    { requestsStarted: 1, requestsSucceeded: 1, requestsFailed: 0, inputTokens: 9, outputTokens: 2 });

  const missingPath = ledgerPath("mid-life-missing");
  const missing = openUsageLedger({ path: missingPath, now: at.bind(null, 13) });
  missing.recordStart();
  rmSync(missingPath);
  // The earlier increment lived only in the deleted file; what merges is this process's unmerged delta.
  missing.recordSuccess(4, 0);
  assert.deepEqual(JSON.parse(readFileSync(missingPath, "utf8")).days["2026-01-13"],
    { requestsStarted: 0, requestsSucceeded: 1, requestsFailed: 0, inputTokens: 4, outputTokens: 0 });
});

test("a merge prunes to the newest kept days and keeps today present", () => {
  const path = ledgerPath("prune");
  const days: Record<string, unknown> = {};
  for (let d = 1; d <= 40; d += 1) days[`2026-01-${String(d).padStart(2, "0")}`] = { requestsStarted: d };
  writeFileSync(path, JSON.stringify({ version: 1, days }));
  const ledger = openUsageLedger({ path, now: at.bind(null, 20) });
  ledger.recordStart();
  const written = JSON.parse(readFileSync(path, "utf8")).days;
  const names = Object.keys(written).sort();
  assert.equal(names.length, 31);
  assert.equal(names[0], "2026-01-10");
  assert.ok(names.includes("2026-01-20"));
  // Day 20 already held 20 starts in the file; the delta added to it instead of replacing the day.
  assert.equal(written["2026-01-20"].requestsStarted, 21);
});

test("one process's file stays identical to its in-memory totals", () => {
  const path = ledgerPath("single-process");
  const ledger = openUsageLedger({ path, now: at.bind(null, 14) });
  ledger.recordStart();
  ledger.recordSuccess(120, 8);
  ledger.recordStart();
  ledger.recordFailure(5, 1);
  const today = ledger.today();
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).days["2026-01-14"], {
    requestsStarted: today.requestsStarted, requestsSucceeded: today.requestsSucceeded, requestsFailed: today.requestsFailed,
    inputTokens: today.inputTokens, outputTokens: today.outputTokens,
  });
  assert.deepEqual(today, {
    requestsStarted: 2, requestsSucceeded: 1, requestsFailed: 1, inputTokens: 125, outputTokens: 9,
    day: "2026-01-14", estimatedUsd: estimateUsd(125, DEFAULT_USD_PER_MTOK),
  });
});
