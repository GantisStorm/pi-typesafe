import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_MAX_INPUT_BYTES, DEFAULT_MAX_QUESTIONS, evaluationSchema, normalizeEvaluationRequest, parseEvaluationRequest, prepareEvaluationRequest, TypeSafeIntegrationError,
} from "../src/index.js";

const hasCode = (code: string) => (error: unknown) => error instanceof TypeSafeIntegrationError && error.code === code;

const nearMiss = () => ({
  state: "synthetic",
  questions: {
    team: { type: "choice", instructions: "Which team?", options: { billing: "Charges and payments", other: "None of these" } },
    refund: { type: "noul", instructions: "Is a refund requested?", criteria: "The sender asks for money back" },
    severity: { type: "score", instructions: "How severe?", levels: ["Cosmetic", "Blocking"] },
    picks: { type: "choice", instructions: "Pick one", choices: ["a", "b"] },
  },
});

const criteriaOf = (request: { questions: unknown }, id: string): unknown =>
  (request.questions as Record<string, { criteria?: unknown }>)[id]?.criteria;

test("admission accepts the near-miss aliases the agent tool has always accepted", () => {
  const prepared = prepareEvaluationRequest(nearMiss());
  assert.deepEqual(criteriaOf(prepared, "team"), { billing: "Charges and payments", other: "None of these" });
  assert.deepEqual(criteriaOf(prepared, "refund"), { true: "The sender asks for money back" });
  assert.deepEqual(criteriaOf(prepared, "severity"), ["Cosmetic", "Blocking"]);
  assert.deepEqual(criteriaOf(prepared, "picks"), { a: null, b: null });
});

test("admission normalizes before it validates", () => {
  const onlyValidAfterNormalizing = { state: "s", questions: { q: { type: "choice", criteria: ["a", "b"] } } };
  assert.throws(() => parseEvaluationRequest(onlyValidAfterNormalizing), hasCode("validation"));
  assert.doesNotThrow(() => prepareEvaluationRequest(onlyValidAfterNormalizing));
});

test("normalization is idempotent", () => {
  const once = normalizeEvaluationRequest(nearMiss());
  assert.deepEqual(normalizeEvaluationRequest(once), once);
  assert.doesNotThrow(() => prepareEvaluationRequest(once));
});

test("admission enforces the byte budget on the serialized request", () => {
  const request = { state: "🙂".repeat(50), questions: { yes: { type: "noul", instructions: "Is this synthetic?" } } };
  const bytes = Buffer.byteLength(JSON.stringify(request), "utf8");
  assert.ok(bytes < DEFAULT_MAX_INPUT_BYTES);
  assert.throws(() => prepareEvaluationRequest(request, { maxInputBytes: bytes - 1 }), hasCode("validation"));
  assert.doesNotThrow(() => prepareEvaluationRequest(request, { maxInputBytes: bytes }));
});

test("the default byte budget is 64 KiB", () => {
  const oversized = { state: "x".repeat(DEFAULT_MAX_INPUT_BYTES), questions: { yes: { type: "noul", instructions: "?" } } };
  assert.equal(DEFAULT_MAX_INPUT_BYTES, 65_536);
  assert.throws(() => prepareEvaluationRequest(oversized), hasCode("validation"));
  assert.doesNotThrow(() => prepareEvaluationRequest(oversized, { maxInputBytes: DEFAULT_MAX_INPUT_BYTES * 2 }));
});

test("a non-finite byte budget is refused instead of being ignored", () => {
  const oversized = { state: "x".repeat(DEFAULT_MAX_INPUT_BYTES), questions: { yes: { type: "noul", instructions: "?" } } };
  for (const maxInputBytes of [NaN, Infinity, 0, -1, 1.5]) {
    assert.throws(() => prepareEvaluationRequest(oversized, { maxInputBytes }), hasCode("configuration"));
  }
});

test("admission still rejects non-JSON state", () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.throws(() => prepareEvaluationRequest({ state: cycle, questions: { yes: { type: "noul", instructions: "?" } } }), hasCode("validation"));
  assert.throws(() => prepareEvaluationRequest({ state: { n: NaN }, questions: { yes: { type: "noul", instructions: "?" } } }), hasCode("validation"));
});

test("a question id that collides with Object.prototype stays an ordinary key", () => {
  // Built through JSON.parse so `__proto__` arrives as a real own property, the way a model's request does.
  const request: unknown = JSON.parse('{"state":"synthetic","questions":{"__proto__":{"type":"noul","instructions":"?"},"ok":{"type":"noul","instructions":"?"}}}');
  const normalized = normalizeEvaluationRequest(request) as { questions: Record<string, unknown> };
  assert.equal(Object.getPrototypeOf(normalized.questions), Object.prototype);
  const prepared = prepareEvaluationRequest(request);
  assert.deepEqual(Object.keys(prepared.questions), ["__proto__", "ok"]);
  assert.equal(Object.prototype.hasOwnProperty.call(prepared.questions, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(prepared.questions), Object.prototype);
});

test("every field the agent authors carries a description, so a bare union is not its only guidance", () => {
  // Walk the serialized schema rather than pin TypeBox's layout: collect every `properties` entry by name.
  const authored = new Map<string, number>();
  const undescribed: string[] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const record = node as Record<string, unknown>;
    if (record.properties && typeof record.properties === "object") {
      for (const [name, field] of Object.entries(record.properties as Record<string, Record<string, unknown>>)) {
        authored.set(name, (authored.get(name) ?? 0) + 1);
        if (typeof field.description !== "string" || field.description.length === 0) undescribed.push(name);
      }
    }
    Object.values(record).forEach(walk);
  };
  walk(JSON.parse(JSON.stringify(evaluationSchema)));
  assert.equal(authored.get("type"), 3, "the schema must still offer noul, choice, and score");
  for (const name of ["state", "questions", "model", "instructions", "criteria"]) assert.ok(authored.has(name), `${name} is still authored`);
  // `true` and `false` inside noul criteria are the only fields whose parent already explains them.
  assert.deepEqual(undescribed.filter(name => name !== "true" && name !== "false"), [], "every authored field must say what it means");
});

test("the request ceiling is the fork's 20 questions, matching the shared harness ceiling", () => {
  assert.equal(DEFAULT_MAX_QUESTIONS, 20, "the installed copy and every adapter chunk at the shared 20-question ceiling");
  const all = Object.fromEntries(Array.from({ length: 21 }, (_v, i) => [`q${i}`, { type: "noul", instructions: "?" }]));
  assert.throws(() => parseEvaluationRequest({ state: "s", questions: all }), hasCode("validation"));
  assert.doesNotThrow(() => parseEvaluationRequest({ state: "s", questions: Object.fromEntries(Object.entries(all).slice(0, 20)) }));
});

test("question ids and choice labels keep their declared length limits", () => {
  const noul = { type: "noul", instructions: "?" };
  assert.throws(() => parseEvaluationRequest({ state: "s", questions: { "": noul } }), hasCode("validation"));
  assert.throws(() => parseEvaluationRequest({ state: "s", questions: { ["x".repeat(101)]: noul } }), hasCode("validation"));
  assert.doesNotThrow(() => parseEvaluationRequest({ state: "s", questions: { ["x".repeat(100)]: noul } }));
  const choice = (label: string) => ({ state: "s", questions: { q: { type: "choice", instructions: "?", criteria: { [label]: null } } } });
  assert.throws(() => parseEvaluationRequest(choice("")), hasCode("validation"));
  assert.throws(() => parseEvaluationRequest(choice("x".repeat(201))), hasCode("validation"));
  assert.doesNotThrow(() => parseEvaluationRequest(choice("x".repeat(200))));
});

test("a hostile accessor or a Proxy whose [[Get]] throws is a classified validation rejection", () => {
  const question: Record<string, unknown> = {};
  Object.defineProperty(question, "criteria", { get() { throw new TypeError("getter boom"); }, enumerable: true, configurable: true });
  assert.throws(() => prepareEvaluationRequest({ state: "s", questions: { q: question } }), hasCode("validation"));
  const throwing = new Proxy({ state: "s", questions: { q: { type: "noul", instructions: "?" } } }, { get() { throw new TypeError("proxy get boom"); } });
  assert.throws(() => parseEvaluationRequest(throwing), hasCode("validation"));
  assert.throws(() => prepareEvaluationRequest(throwing), hasCode("validation"));
});

test("a null options argument is treated as defaults", () => {
  assert.doesNotThrow(() => prepareEvaluationRequest({ state: "s", questions: { q: { type: "noul", instructions: "?" } } }, null));
});
