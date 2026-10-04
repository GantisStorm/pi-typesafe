import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { chunkEvaluationRequest, fanOut } from "../src/batch.js";
import { createTypeSafe } from "../src/client.js";
import { TypeSafeIntegrationError } from "../src/errors.js";
import { openUsageLedger } from "../src/usage.js";
import { DEFAULT_MAX_QUESTIONS } from "../src/schema.js";
import { noul } from "../src/index.js";
import type { Questions, SystemOneRequest } from "../src/index.js";

const sample = { state: "synthetic", questions: { yes: noul("Is this synthetic?") } };
const manyQuestions = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`q${index}`, noul(`Question ${index}?`)]));

const workspace = mkdtempSync(join(tmpdir(), "pi-typesafe-batch-"));
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
const savedKey = process.env.TYPESAFE_API_KEY;
before(() => {
  process.env.PI_CODING_AGENT_DIR = workspace;
  process.env.TYPESAFE_API_KEY = "batch-test-key";
});
after(() => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = savedKey;
});

const ledgerFor = (name: string) => openUsageLedger({ path: join(workspace, `${name}.json`) });

/** Answers every question with a fixed Noul probability, so merging is observable per question id. */
function answeringFetch(counter: { calls: number }) {
  return async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    counter.calls++;
    const request = JSON.parse(String(init?.body)) as SystemOneRequest<Questions>;
    const answers = Object.fromEntries(Object.keys(request.questions).map(id => [id, { type: "noul", noul: 0.75 }]));
    return Response.json({ model: "jev-test", answers, usage: { input_tokens: 10, output_tokens: 0 } });
  };
}

test("fan-out bounds concurrency, preserves order, and never throws", async () => {
  let inFlight = 0;
  let peak = 0;
  const results = await fanOut([1, 2, 3, 4, 5, 6, 7], async value => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise(resolve => setTimeout(resolve, 5));
    inFlight--;
    if (value === 4) throw new Error(`bad ${value}`);
    return value * 2;
  }, { concurrency: 3 });
  assert.equal(peak, 3);
  assert.deepEqual(results.map(result => result.ok ? result.value : "failed"), [2, 4, 6, "failed", 10, 12, 14]);
  assert.deepEqual(results.map(result => result.index), [0, 1, 2, 3, 4, 5, 6]);
  const failure = results[3];
  assert.ok(failure && !failure.ok);
  assert.equal(failure.skipped, false);
});

test("fan-out stops launching after a stop rule and marks the rest skipped", async () => {
  const started: number[] = [];
  const results = await fanOut([0, 1, 2, 3, 4, 5], async value => {
    started.push(value);
    if (value === 2) throw new TypeSafeIntegrationError("budget", "cap reached");
    return value;
  }, { concurrency: 1, stopOn: error => error instanceof TypeSafeIntegrationError && error.code === "budget" });
  assert.deepEqual(started, [0, 1, 2]);
  assert.equal(results.filter(result => !result.ok && result.skipped).length, 3);
  const stopped = results[2];
  assert.ok(stopped && !stopped.ok);
  assert.equal(stopped.skipped, false);
});

test("fan-out stops launching once the caller's signal aborts", async () => {
  const controller = new AbortController();
  const results = await fanOut([0, 1, 2, 3], async value => {
    if (value === 1) controller.abort();
    return value;
  }, { concurrency: 1, signal: controller.signal });
  assert.equal(results[0]?.ok, true);
  assert.equal(results[1]?.ok, true);
  const abandoned = results[2];
  assert.ok(abandoned && !abandoned.ok);
  assert.equal(abandoned.skipped, true);
  assert.ok(abandoned.error instanceof TypeSafeIntegrationError && abandoned.error.code === "aborted");
});

test("the splitter is pure: a request that already fits is one chunk, unchanged", () => {
  assert.deepEqual(chunkEvaluationRequest(sample), [sample]);
  // No validation here: an invalid request is passed through and fails once, per chunk, at admission.
  const invalid = { state: "synthetic", questions: {} };
  assert.deepEqual(chunkEvaluationRequest(invalid), [invalid]);
});

test("a non-finite concurrency uses the default instead of skipping every item", async () => {
  const results = await fanOut([1, 2, 3], async value => value * 2, { concurrency: NaN });
  assert.deepEqual(results.map(result => result.ok ? result.value : "failed"), [2, 4, 6]);
  assert.equal(results.every(result => result.ok), true);
});

test("a non-finite question limit uses the default instead of dropping every question", () => {
  const questions = manyQuestions(3);
  const chunks = chunkEvaluationRequest({ state: "synthetic", questions }, { maxQuestions: NaN });
  assert.deepEqual(chunks.map(chunk => Object.keys(chunk.questions).length), [3]);
});

test("an invalid request is one settled failure, not a thrown error", async () => {
  const counter = { calls: 0 };
  const client = createTypeSafe({ ledger: ledgerFor("invalid"), fetch: answeringFetch(counter) });
  const batch = await client.evaluateMany([{ state: "synthetic", questions: {} }]);
  assert.equal(counter.calls, 0);
  assert.equal(batch.ok, false);
  const failed = batch.results[0];
  assert.ok(failed && !failed.ok);
  assert.ok(failed.error instanceof TypeSafeIntegrationError && failed.error.code === "validation");
  assert.equal(failed.skipped, false);
  await assert.rejects(client.evaluate({ state: "synthetic", questions: {} }), (error: unknown) => error instanceof TypeSafeIntegrationError && error.code === "validation");
});

test("more questions than one request may carry are split in order", () => {
  const questions = manyQuestions(DEFAULT_MAX_QUESTIONS + 3);
  const chunks = chunkEvaluationRequest({ state: "many", questions });
  assert.deepEqual(chunks.map(chunk => Object.keys(chunk.questions).length), [DEFAULT_MAX_QUESTIONS, 3]);
  const ids = chunks.flatMap(chunk => Object.keys(chunk.questions));
  assert.deepEqual(ids, Object.keys(questions));
  assert.equal(chunks.every(chunk => chunk.state === "many"), true);
});

test("evaluateAll spends one request per chunk and merges answers, usage, and model", async () => {
  const counter = { calls: 0 };
  const client = createTypeSafe({ ledger: ledgerFor("many"), fetch: answeringFetch(counter) });
  const questions = manyQuestions(DEFAULT_MAX_QUESTIONS + 2);
  const batch = await client.evaluateAll({ state: "many", questions }, { concurrency: 2 });
  assert.equal(counter.calls, 2);
  assert.equal(batch.ok, true);
  assert.equal(batch.failures, 0);
  assert.equal(batch.skipped, 0);
  assert.equal(Object.keys(batch.answers).length, DEFAULT_MAX_QUESTIONS + 2);
  assert.equal(batch.model, "jev-test");
  assert.equal(batch.usage.input_tokens, 20);
  assert.equal(client.getUsage().requestsSucceeded, 2);
});

test("evaluateMany reports per-request failures and stops submitting after a budget error", async () => {
  const counter = { calls: 0 };
  const client = createTypeSafe({ maxRequests: 1, ledger: ledgerFor("budget"), fetch: answeringFetch(counter) });
  const batch = await client.evaluateMany([sample, sample, sample], { concurrency: 1 });
  assert.equal(counter.calls, 1);
  assert.equal(batch.ok, false);
  // One request succeeded, one failed on the session cap, and the third was never submitted.
  assert.equal(batch.failures, 2);
  assert.equal(batch.skipped, 1);
  const first = batch.results[0];
  assert.equal(first?.ok, true);
  assert.equal(Object.keys(batch.answers).length, 1);
  assert.ok(batch.elapsedMs >= 0);
});

test("a batched answer keyed __proto__ merges as an ordinary own key", async () => {
  const questions = JSON.parse('{"__proto__":{"type":"noul","instructions":"?"},"yes":{"type":"noul","instructions":"?"}}') as Questions;
  const counter = { calls: 0 };
  const client = createTypeSafe({ ledger: ledgerFor("prototype-key"), fetch: answeringFetch(counter) });
  const batch = await client.evaluateAll({ state: "synthetic", questions });
  assert.equal(counter.calls, 1);
  assert.equal(batch.ok, true);
  assert.deepEqual(Object.keys(batch.answers), ["__proto__", "yes"]);
  assert.equal(Object.getPrototypeOf(batch.answers), Object.prototype);
  assert.deepEqual(Object.getOwnPropertyDescriptor(batch.answers, "__proto__")?.value, { type: "noul", noul: 0.75 });
});

test("a daily cap stops the batch with the cap named", async () => {
  const counter = { calls: 0 };
  const client = createTypeSafe({ maxRequestsPerDay: 1, ledger: ledgerFor("day-cap"), fetch: answeringFetch(counter) });
  const batch = await client.evaluateMany([sample, sample]);
  assert.equal(counter.calls, 1);
  const second = batch.results[1];
  assert.ok(second && !second.ok);
  assert.ok(second.error instanceof TypeSafeIntegrationError && second.error.code === "budget");
  assert.ok(second.error.message.includes("daily request cap"));
});

test("batching admits with the client's byte budget, not the default one", async () => {
  const counter = { calls: 0 };
  const client = createTypeSafe({ maxInputBytes: 131_072, ledger: ledgerFor("batch-bytes"), fetch: answeringFetch(counter) });
  const large = { state: "x".repeat(70_000), questions: { yes: noul("Is this synthetic?") } };
  assert.equal((await client.evaluate(large)).answers.yes?.type, "noul");
  const batch = await client.evaluateMany([large]);
  assert.equal(batch.ok, true);
  assert.equal(counter.calls, 2);
});

test("a stop rule that throws cannot reject the pool", async () => {
  const results = await fanOut([1, 2, 3], async () => { throw new Error("worker failed"); }, {
    concurrency: 1,
    stopOn: () => { throw new Error("rule failed"); },
  });
  assert.equal(results.length, 3);
  assert.equal(results[0]?.ok, false);
  // The rule could not be evaluated, so the rest is not launched: a stop rule exists to guard further spending.
  assert.deepEqual(results.map(result => !result.ok && result.skipped), [false, true, true]);
});

test("a failure that is not a budget or cancellation stops nothing", async () => {
  const counter = { calls: 0 };
  const client = createTypeSafe({ ledger: ledgerFor("continue"), fetch: answeringFetch(counter) });
  // The first request is rejected at admission; the two valid ones must still be submitted, in order.
  const requests: SystemOneRequest<Questions>[] = [{ state: "synthetic", questions: {} }, sample, sample];
  const batch = await client.evaluateMany(requests, { concurrency: 1 });
  assert.equal(counter.calls, 2, "a validation failure must not stop the remaining requests");
  assert.equal(batch.failures, 1);
  assert.equal(batch.skipped, 0);
  assert.deepEqual(batch.results.map(result => result.ok), [false, true, true]);
});

test("a degenerate question limit is clamped instead of looping forever", () => {
  // A limit below 1 would advance the chunk loop by zero and never terminate, so the splitter floors it at 1. The call
  // runs in a fresh process because a regression there would hang this one; the timeout bounds that failure. The child
  // needs `await import` rather than a static import: its specifier is resolved at run time inside the spawned script,
  // which a static import in this file cannot reach into.
  const source = `const { chunkEvaluationRequest } = await import(${JSON.stringify(resolve("src/batch.ts"))});
const questions = Object.fromEntries(Array.from({ length: 3 }, (_value, index) => ["q" + index, { type: "noul" }]));
process.stdout.write(JSON.stringify(chunkEvaluationRequest({ state: "s", questions }, { maxQuestions: 0 }).map(chunk => Object.keys(chunk.questions).length)));`;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    cwd: process.cwd(),
    timeout: 30_000,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || `the splitter did not terminate (signal ${result.signal})`);
  assert.deepEqual(JSON.parse(result.stdout), [1, 1, 1]);
});
