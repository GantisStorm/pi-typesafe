import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Extension, ExtensionAPI, RegisteredCommand, RegisteredTool } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

let temporary: string;
let extension: Extension;
let tool: RegisteredTool;
let command: RegisteredCommand;
const savedKey = process.env.TYPESAFE_API_KEY;
const savedEnabled = process.env.PI_TYPESAFE_ENABLED;
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
const savedBackend = process.env.PI_TYPESAFE_BACKEND;
// The extension resolves its backend, endpoint, and disclosure text when the module is first evaluated, and a client
// then reads that backend's key. A static import runs before any statement here, so it would let the ambient
// environment choose both — a machine with PI_TYPESAFE_BACKEND=commandcode and a real COMMANDCODE_API_KEY made a
// stub-hosted extension resolve Command Code and hold that credential. A dynamic import cannot be static because the
// variable has to be set first; the loader loads its own copy, so pin this one before it is evaluated too.
process.env.PI_TYPESAFE_BACKEND = "typesafe";
const { default: typesafeExtension } = await import("../src/extension.js");
const originalFetch = globalThis.fetch;
// No test may reach the network. `before()` installs the stub transport every client uses; this guarded fallback covers
// every other moment, so a client built without a stub records the attempt and is refused instead of spending a real
// credential. The last test in this file asserts the list stayed empty.
const outboundRequests: string[] = [];
globalThis.fetch = async (input: RequestInfo | URL) => {
  outboundRequests.push(String(input));
  throw new Error(`refusing a real outbound request to ${String(input)}`);
};
const stubbedRequests: string[] = [];
const notices: string[] = [];
let confirmResult = true;
let confirmations = 0;
let editorText: string | undefined;
let networkCalls = 0;
let modelListCalls = 0;
let customResult: string | undefined;
const ui = {
  notify: (text: string) => { notices.push(text); },
  confirm: async () => { confirmations++; return confirmResult; },
  editor: async () => editorText,
  custom: async () => customResult,
  input: async () => { throw new Error("plain input must not be used when custom UI exists"); },
};
const ctx = { hasUI: true, ui };
const runCommand = (args: string, context = ctx) => Reflect.apply(command.handler, command, [args, context]);
const runTool = (signal?: AbortSignal) => Reflect.apply(tool.definition.execute, tool.definition, [
  "test-call", { state: "synthetic", questions: { yes: { type: "noul", instructions: "Is this synthetic?" } } }, signal, undefined, ctx,
]);

before(async () => {
  temporary = await mkdtemp(join(tmpdir(), "pi-typesafe-test-"));
  delete process.env.PI_TYPESAFE_ENABLED;
  process.env.PI_TYPESAFE_BACKEND = "typesafe";
  process.env.PI_CODING_AGENT_DIR = temporary;
  process.env.TYPESAFE_API_KEY = "offline-test-key";
  globalThis.fetch = async (input) => {
    stubbedRequests.push(String(input));
    if (String(input).endsWith("/v1/models")) {
      modelListCalls++;
      return Response.json({ models: [{ name: "jev-latest", description: "", release_date: "2026-01-01" }] });
    }
    networkCalls++;
    return Response.json({ model: "jev-test", answers: { yes: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 12, output_tokens: 0 } });
  };
  const loader = new DefaultResourceLoader({
    cwd: temporary,
    agentDir: temporary,
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [resolve("src/extension.ts")],
  });
  await loader.reload();
  const result = loader.getExtensions();
  assert.deepEqual(result.errors, [], "native Pi loader must accept the extension");
  const loaded = result.extensions[0];
  assert.ok(loaded);
  extension = loaded;
  const registeredTool = extension.tools.get("typesafe_evaluate");
  const registeredCommand = extension.commands.get("typesafe");
  assert.ok(registeredTool);
  assert.ok(registeredCommand);
  tool = registeredTool;
  command = registeredCommand;
});

after(async () => {
  globalThis.fetch = originalFetch;
  if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = savedKey;
  if (savedEnabled === undefined) delete process.env.PI_TYPESAFE_ENABLED; else process.env.PI_TYPESAFE_ENABLED = savedEnabled;
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  if (savedBackend === undefined) delete process.env.PI_TYPESAFE_BACKEND; else process.env.PI_TYPESAFE_BACKEND = savedBackend;
  if (temporary) await rm(temporary, { recursive: true, force: true });
});


test("default-disabled tool cannot submit data", async () => {
  await assert.rejects(runTool(), /disabled/);
  assert.equal(networkCalls, 0);
});

test("setup and status never display the API key", async () => {
  await runCommand("setup");
  await runCommand("status");
  assert.equal(notices.some(text => text.includes("offline-test-key")), false);
});


test("login refuses to shadow an environment key", async () => {
  await runCommand("login");
  assert.equal(modelListCalls, 0);
});

test("declining consent keeps the tool disabled", async () => {
  confirmResult = false;
  await runCommand("enable");
  await assert.rejects(runTool(), /disabled/);
  assert.equal(networkCalls, 0);
});

test("explicit consent enables the real registered tool and returns structured results", async () => {
  confirmResult = true;
  await runCommand("enable");
  const result = await runTool();
  assert.equal(result.details.answers.yes.noul, 0.9);
  assert.equal(networkCalls, 1);
  assert.ok(confirmations >= 2);
  const renderer = tool.definition.renderResult;
  assert.ok(renderer);
  const component = Reflect.apply(renderer, tool.definition, [result, { expanded: true, isPartial: false }, {}]);
  for (const width of [40, 80, 120]) {
    const lines: string[] = component.render(width);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    assert.ok(lines.join("\n").includes("P(yes)"));
  }
});

test("disable stops future calls without resetting usage", async () => {
  await runCommand("disable");
  await assert.rejects(runTool(), /disabled/);
  await runCommand("status");
  assert.ok(notices.at(-1)?.includes("1/20 attempts"));
});

test("invalid playground JSON and cancellation do not submit data", async () => {
  editorText = '{"broken":';
  await runCommand("playground");
  assert.ok(notices.at(-1)?.includes("Invalid JSON"));
  editorText = undefined;
  await runCommand("playground");
  assert.equal(networkCalls, 1);
});

test("playground validates questions before requesting consent", async () => {
  editorText = JSON.stringify({ state: "example", questions: {} });
  const prior = confirmations;
  await runCommand("playground");
  assert.equal(confirmations, prior);
  assert.equal(networkCalls, 1);
  assert.ok(notices.at(-1)?.includes("Invalid evaluation request"));
});

test("test command requires confirmation and does not enable agent calls", async () => {
  confirmResult = false;
  await runCommand("test");
  assert.equal(networkCalls, 1);
  await assert.rejects(runTool(), /disabled/);
});

test("login verifies, stores with owner-only permissions, and never echoes the key", async () => {
  delete process.env.TYPESAFE_API_KEY;
  const storedPath = join(temporary, "pi-typesafe", "auth.json");
  customResult = undefined;
  await runCommand("login");
  assert.ok(notices.at(-1)?.includes("cancelled"));
  assert.equal(existsSync(storedPath), false);
  customResult = "nope";
  await runCommand("login");
  assert.ok(notices.at(-1)?.includes("does not look like"));
  assert.equal(modelListCalls, 0);
  assert.equal(existsSync(storedPath), false);
  customResult = "ts_live_key_0123456789abcdef";
  await runCommand("login");
  assert.equal(modelListCalls, 1);
  assert.ok(notices.at(-1)?.includes("Key verified (1 model available)"));
  assert.equal(notices.some(text => text.includes("ts_live_key")), false);
  assert.equal(statSync(storedPath).mode & 0o777, 0o600);
  await runCommand("status");
  assert.ok(notices.at(-1)?.includes("TypeSafe key: /typesafe login"));
  await runCommand("setup");
  assert.ok(notices.at(-1)?.includes("configured via /typesafe login"));
  // The stored key powers the real tool after consent.
  confirmResult = true;
  await runCommand("enable");
  await runTool();
  assert.equal(networkCalls, 2);
  await runCommand("logout");
  assert.equal(existsSync(storedPath), false);
  await assert.rejects(runTool(), /disabled/);
  await runCommand("status");
  assert.ok(notices.at(-1)?.includes("TypeSafe key: missing"));
  process.env.TYPESAFE_API_KEY = "offline-test-key";
});

test("new sessions reset opt-in; headless opt-in is explicit", async () => {
  const handlers = extension.handlers.get("session_start");
  assert.ok(handlers?.length);
  for (const handler of handlers) await Reflect.apply(handler, extension, [{ reason: "new" }, ctx]);
  await assert.rejects(runTool(), /disabled/);
  process.env.PI_TYPESAFE_ENABLED = "1";
  for (const handler of handlers) await Reflect.apply(handler, extension, [{ reason: "startup" }, ctx]);
  await runTool();
  assert.equal(networkCalls, 3);
  await runCommand("status");
  assert.ok(notices.at(-1)?.includes("1/20 attempts"));
});

test("an enabled session with no key announces that judgments are skipped", async () => {
  delete process.env.TYPESAFE_API_KEY;
  process.env.PI_TYPESAFE_ENABLED = "1";
  const handlers = extension.handlers.get("session_start") ?? [];
  const before = notices.length;
  for (const handler of handlers) await Reflect.apply(handler, extension, [{ reason: "startup" }, ctx]);
  const said = notices.slice(before).join("\n");
  assert.ok(said.includes("judgments are skipped"));
  assert.ok(said.includes("TypeSafe key: missing"));
  // A key that appears later silences the next startup notice.
  process.env.TYPESAFE_API_KEY = "offline-test-key";
  const again = notices.length;
  for (const handler of handlers) await Reflect.apply(handler, extension, [{ reason: "reload" }, ctx]);
  assert.equal(notices.slice(again).some(text => text.includes("judgments are skipped")), false);
});

test("a rejected key is called out once per session and shows up in status", async () => {
  process.env.PI_TYPESAFE_ENABLED = "1";
  const handlers = extension.handlers.get("session_start") ?? [];
  for (const handler of handlers) await Reflect.apply(handler, extension, [{ reason: "startup" }, ctx]);
  const before = notices.length;
  const offlineStub = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ error: { message: "invalid key" } }, { status: 401 });
  try {
    await assert.rejects(runTool(), /HTTP 401/);
    await assert.rejects(runTool(), /HTTP 401/);
  } finally {
    globalThis.fetch = offlineStub;
  }
  // Two failed calls, one callout: the reason is loud once, not once per call.
  assert.equal(notices.slice(before).filter(text => text.includes("not authenticated")).length, 1);
  await runCommand("status");
  assert.ok(notices.at(-1)?.includes("was rejected"));
  assert.ok(notices.at(-1)?.includes("Today "));
  assert.ok(notices.at(-1)?.includes("failed"));
});

test("the registered tool admits the same near-miss aliases as the library", async () => {
  process.env.PI_TYPESAFE_ENABLED = "1";
  const handlers = extension.handlers.get("session_start");
  for (const handler of handlers ?? []) await Reflect.apply(handler, extension, [{ reason: "startup" }, ctx]);
  const before = networkCalls;
  const result = await Reflect.apply(tool.definition.execute, tool.definition, [
    "test-call",
    { state: "synthetic", questions: { yes: { type: "noul", instructions: "Is this synthetic?", criteria: "Is this synthetic data?" } } },
    undefined,
    undefined,
    ctx,
  ]);
  assert.equal(networkCalls, before + 1);
  assert.equal(result.details.answers.yes.noul, 0.9);
});

test("a blank backend variable loads the default backend while an unknown name still fails", () => {
  // The backend is chosen once, at module load, so this needs a fresh process rather than the shared loader: a static
  // import cannot reach into a child process, and the child's own import is exactly the boundary under test.
  const source = `await import(${JSON.stringify(resolve("src/extension.ts"))}); process.stdout.write("loaded");`;
  const launch = (backend: string) => spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    cwd: process.cwd(),
    env: { ...process.env, PI_TYPESAFE_BACKEND: backend },
    encoding: "utf8",
  });
  for (const blank of ["", "   "]) {
    const result = launch(blank);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "loaded");
  }
  const invalid = launch("typesafe-v2");
  assert.notEqual(invalid.status, 0);
  assert.match(String(invalid.stderr), /Unknown judgment backend/);
});

test("the headless command surface reports through the message channel and stays closed", async () => {
  const said: string[] = [];
  const registered = new Map<string, { name?: string; handler?: (...args: unknown[]) => Promise<unknown> }>();
  const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>();
  const savedKey = process.env.TYPESAFE_API_KEY;
  const savedEnabledNow = process.env.PI_TYPESAFE_ENABLED;
  const savedFetch = globalThis.fetch;
  process.env.TYPESAFE_API_KEY = "offline-test-key";
  try {
    // No registerEntryRenderer: this is the OMP host shape the fork supports, where results come back as text.
    const stub = {
      on: (event: string, handler: (...args: unknown[]) => Promise<unknown>) => { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
      sendMessage: (message: { content?: string }) => { said.push(String(message.content)); },
      appendEntry: () => {},
      registerTool: (definition: { name?: string }) => { registered.set(String(definition.name), definition); },
      registerCommand: (name: string, definition: { handler?: (...args: unknown[]) => Promise<unknown> }) => { registered.set(name, definition); },
    };
    globalThis.fetch = async (_input, init) => {
      networkCalls++;
      const request = JSON.parse(String(init?.body)) as { questions: Record<string, { type: string; criteria?: unknown }> };
      const answers = Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
        if (question.type === "noul") return [id, { type: "noul", noul: 0.9 }];
        if (question.type === "choice") {
          const labels = Object.keys(question.criteria as Record<string, unknown>);
          return [id, { type: "choice", choice: labels[0], confidence: 0.9, probabilities: Object.fromEntries(labels.map((label, index) => [label, index === 0 ? 0.9 : 0.05])) }];
        }
        const levels = question.criteria as string[];
        return [id, { type: "score", score: 0, confidence: 0.9, legend: levels.join(" | "), probabilities: Object.fromEntries(levels.map((_, index) => [String(index), index === 0 ? 0.9 : 0.05])) }];
      }));
      return Response.json({ model: "jev-test", answers, usage: { input_tokens: 5, output_tokens: 0 } });
    };
    typesafeExtension(stub as unknown as ExtensionAPI);
    const handler = registered.get("typesafe")?.handler;
    assert.ok(handler);
    const headless = { hasUI: false };
    process.env.PI_TYPESAFE_ENABLED = "1";
    for (const start of handlers.get("session_start") ?? []) await Reflect.apply(start, null, [{ reason: "startup" }, headless]);
    const before = networkCalls;
    await Reflect.apply(handler, null, ["test", headless]);
    assert.equal(networkCalls, before + 1);
    assert.ok(said.at(-1)?.includes("P(yes)"), "a host without the entry renderer must still get the result as text");
    await Reflect.apply(handler, null, ["enable", headless]);
    assert.ok(said.at(-1)?.includes("needs interactive Pi"));
    await Reflect.apply(handler, null, ["disable", headless]);
    assert.ok(said.at(-1)?.includes("disabled"));
    await Reflect.apply(handler, null, ["test", headless]);
    assert.ok(said.at(-1)?.includes("needs interactive Pi"));
    assert.equal(networkCalls, before + 1);
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = savedKey;
    if (savedEnabledNow === undefined) delete process.env.PI_TYPESAFE_ENABLED; else process.env.PI_TYPESAFE_ENABLED = savedEnabledNow;
  }
});

// The surfaces below need no real TUI: the Pi loader already hands the test the registered entry renderer and the
// tools' own hooks, and a stub host can stand in for the runner. Each test asserts what the consumer sees - the
// pending line, the renderer's three states, the autocomplete list, the file tool's refusal, the operator messages,
// and the status line - instead of private call counts.

/** A result with one answer of each kind, shaped exactly as the client returns it; renderers never mutate it. */
const judgment = {
  model: "jev-test",
  answers: {
    category: { type: "choice", choice: "billing", confidence: 0.9, probabilities: { billing: 0.9, technical: 0.05, other: 0.05 } },
    urgent: { type: "noul", noul: 0.75 },
    frustration: { type: "score", score: 1, confidence: 0.6, legend: "Neutral request | Frustrated but civil | Angry or threatening", probabilities: { "0": 0.3, "1": 0.6, "2": 0.1 } },
  },
  usage: { input_tokens: 12, output_tokens: 3 },
  elapsedMs: 7,
};

test("the pending call line names how many questions are in flight", () => {
  const renderCall = tool.definition.renderCall;
  assert.ok(renderCall);
  const two = Reflect.apply(renderCall, tool.definition, [{ state: "synthetic", questions: { a: { type: "noul", instructions: "a" }, b: { type: "noul", instructions: "b" } } }, {}]);
  assert.equal(two.render(120)[0]?.trimEnd(), "TypeSafe · 2 questions · external request");
  const none = Reflect.apply(renderCall, tool.definition, [{}, {}]);
  assert.equal(none.render(120)[0]?.trimEnd(), "TypeSafe · 0 questions · external request");
});

test("the result renderer separates pending, text-only, and structured results", () => {
  const renderResult = tool.definition.renderResult;
  assert.ok(renderResult);
  const pending = Reflect.apply(renderResult, tool.definition, [{ content: [] }, { expanded: false, isPartial: true }, {}]);
  assert.equal(pending.render(200)[0]?.trimEnd(), "TypeSafe · waiting for response");
  // A host that forwards a plain-text result has no `details`, so the text is shown verbatim and non-text parts are dropped.
  const textOnly = Reflect.apply(renderResult, tool.definition, [{ content: [{ type: "text", text: "first" }, { type: "image", data: "unused" }, { type: "text", text: "second" }] }, { expanded: false, isPartial: false }, {}]);
  assert.equal(textOnly.render(200).map((line: string) => line.trimEnd()).join("\n"), "first\nsecond");
  const collapsed = Reflect.apply(renderResult, tool.definition, [{ content: [], details: judgment }, { expanded: false, isPartial: false }, {}]).render(200).join("\n");
  assert.ok(collapsed.includes('TypeSafe · "jev-test" · 7 ms'));
  assert.ok(collapsed.includes('"category": "billing" · confidence 0.900'));
  assert.ok(collapsed.includes('"urgent": P(yes) = 0.750'));
  assert.ok(collapsed.includes('"frustration": 1.000 · confidence 0.600'));
  assert.ok(collapsed.includes("12 input / 3 output tokens"));
  assert.ok(collapsed.includes("Confidence is distribution concentration, not proof of correctness."));
  assert.equal(collapsed.includes('"billing":0.9'), false, "a collapsed result hides the distribution");
  const spread = Reflect.apply(renderResult, tool.definition, [{ content: [], details: judgment }, { expanded: true, isPartial: false }, {}]).render(200).join("\n");
  assert.ok(spread.includes('"billing":0.9'));
});

test("the session entry renderer replays a stored judgment or reports that none exists", () => {
  const renderer = extension.entryRenderers?.get("typesafe-result");
  assert.ok(renderer, "the loader must observe the entry renderer the extension registers for Pi");
  const entry = { type: "custom", customType: "typesafe-result" };
  const collapsed = Reflect.apply(renderer, undefined, [{ ...entry, data: judgment }, { expanded: false }, {}]).render(200).join("\n");
  assert.ok(collapsed.includes('"urgent": P(yes) = 0.750'));
  assert.equal(collapsed.includes('"billing":0.9'), false);
  const spread = Reflect.apply(renderer, undefined, [{ ...entry, data: judgment }, { expanded: true }, {}]).render(200).join("\n");
  assert.ok(spread.includes('"billing":0.9'));
  const empty = Reflect.apply(renderer, undefined, [entry, { expanded: false }, {}]);
  assert.equal(empty.render(200)[0]?.trimEnd(), "TypeSafe · no result");
});

test("the command suggests matching actions and offers nothing for a miss", async () => {
  const complete = command.getArgumentCompletions;
  assert.ok(complete);
  assert.deepEqual(await Reflect.apply(complete, command, ["lo"]), [{ value: "login", label: "login" }, { value: "logout", label: "logout" }]);
  assert.equal((await Reflect.apply(complete, command, [""]))?.length, 8);
  assert.equal(await Reflect.apply(complete, command, ["zzz"]), null);
});

test("a headless host hears about each degraded key once per session", async () => {
  const said: string[] = [];
  const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>();
  const tools = new Map<string, { execute?: (...args: unknown[]) => Promise<unknown> }>();
  const savedKeyNow = process.env.TYPESAFE_API_KEY;
  const savedEnabledNow = process.env.PI_TYPESAFE_ENABLED;
  const savedFetch = globalThis.fetch;
  try {
    process.env.PI_TYPESAFE_ENABLED = "1";
    const stub = {
      on: (event: string, handler: (...args: unknown[]) => Promise<unknown>) => { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
      sendMessage: (message: { content?: string }) => { said.push(String(message.content)); },
      appendEntry: () => {},
      registerTool: (definition: { name?: string; execute?: (...args: unknown[]) => Promise<unknown> }) => { tools.set(String(definition.name), definition); },
      registerCommand: () => {},
    };
    typesafeExtension(stub as unknown as ExtensionAPI);
    const headless = { hasUI: false };
    const execute = tools.get("typesafe_evaluate")?.execute;
    assert.ok(execute);
    const call = ["test-call", { state: "synthetic", questions: { yes: { type: "noul", instructions: "Is this synthetic?" } } }, undefined, undefined, headless];
    // With no key at all, the startup notice and the failed call both reach the message channel, once each.
    delete process.env.TYPESAFE_API_KEY;
    for (const handler of handlers.get("session_start") ?? []) await Reflect.apply(handler, null, [{ reason: "startup" }, headless]);
    assert.ok(said.at(-1)?.includes("judgments are skipped"), said.at(-1));
    await assert.rejects(Reflect.apply(execute, undefined, call), /No API key/);
    assert.ok(said.at(-1)?.includes("not authenticated"), said.at(-1));
    await assert.rejects(Reflect.apply(execute, undefined, call), /No API key/);
    assert.equal(said.filter(text => text.includes("not authenticated")).length, 1, "one callout per distinct degradation per session");
    // A rejected key is a different degradation, so it speaks once on its own.
    process.env.TYPESAFE_API_KEY = "offline-test-key";
    globalThis.fetch = async () => Response.json({ error: { message: "invalid key" } }, { status: 401 });
    for (const handler of handlers.get("session_start") ?? []) await Reflect.apply(handler, null, [{ reason: "startup" }, headless]);
    await assert.rejects(Reflect.apply(execute, undefined, call), /HTTP 401/);
    await assert.rejects(Reflect.apply(execute, undefined, call), /HTTP 401/);
    assert.equal(said.filter(text => text.includes("HTTP 401")).length, 1, "the rejection is reported once, not once per call");
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKeyNow === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = savedKeyNow;
    if (savedEnabledNow === undefined) delete process.env.PI_TYPESAFE_ENABLED; else process.env.PI_TYPESAFE_ENABLED = savedEnabledNow;
  }
});

test("an unknown action lists the whole command surface, and a bare invocation shows status", async () => {
  await runCommand("bogus");
  assert.ok(notices.at(-1)?.includes("Usage: /typesafe login | logout | setup | status | enable | disable | test | playground"), notices.at(-1));
  await runCommand("");
  assert.ok(notices.at(-1)?.includes("TypeSafe:"), notices.at(-1));
});

test("the pre-validation hook admits the near-miss alias shapes before Pi validates them", () => {
  const prepare = tool.definition.prepareArguments;
  assert.ok(prepare);
  const prepared = Reflect.apply(prepare, tool.definition, [{
    state: "synthetic",
    questions: {
      yes: { type: "noul", instructions: "Is this synthetic?", criteria: "Is this synthetic data?" },
      pick: { type: "choice", instructions: "Pick one.", options: ["billing", "technical"] },
      rate: { type: "score", instructions: "How urgent?", levels: ["Calm", "Urgent"] },
    },
  }]) as { questions: Record<string, { criteria: unknown }> };
  assert.deepEqual(prepared.questions.yes?.criteria, { true: "Is this synthetic data?" });
  assert.deepEqual(prepared.questions.pick?.criteria, { billing: null, technical: null });
  assert.deepEqual(prepared.questions.rate?.criteria, ["Calm", "Urgent"]);
});

test("the file judgment tool stays closed until both opt-ins are set", async () => {
  const filesTool = extension.tools.get("typesafe_evaluate_files");
  assert.ok(filesTool);
  const runFiles = () => Reflect.apply(filesTool.definition.execute, filesTool.definition, [
    "files-call", { questions: { yes: { type: "noul", instructions: "Is this synthetic?" } }, paths: ["missing-file.ts"] }, undefined, undefined, { hasUI: false, cwd: temporary },
  ]);
  const savedFiles = process.env.PI_TYPESAFE_FILES_ENABLED;
  const before = networkCalls;
  try {
    delete process.env.PI_TYPESAFE_FILES_ENABLED;
    process.env.PI_TYPESAFE_ENABLED = "1";
    for (const handler of extension.handlers.get("session_start") ?? []) await Reflect.apply(handler, extension, [{ reason: "startup" }, ctx]);
    await assert.rejects(runFiles(), /File judgments are disabled/);
    // The supplied-state opt-in alone does not open the file tool; the next refusal is about the missing path.
    process.env.PI_TYPESAFE_FILES_ENABLED = "1";
    await assert.rejects(runFiles(), (error: Error) => !/File judgments are disabled/.test(error.message));
    assert.equal(networkCalls, before, "a refused file selection never reaches the endpoint");
  } finally {
    if (savedFiles === undefined) delete process.env.PI_TYPESAFE_FILES_ENABLED; else process.env.PI_TYPESAFE_FILES_ENABLED = savedFiles;
  }
});

test("an unusable stored key is named instead of being treated as missing", async () => {
  const storedPath = join(temporary, "pi-typesafe", "auth.json");
  const savedKeyNow = process.env.TYPESAFE_API_KEY;
  try {
    delete process.env.TYPESAFE_API_KEY;
    await mkdir(join(temporary, "pi-typesafe"), { recursive: true });
    await writeFile(storedPath, JSON.stringify({ apiKey: "ts_live_shared_key" }));
    await chmod(storedPath, 0o644);
    await runCommand("setup");
    assert.ok(notices.at(-1)?.includes("Key unusable — "), "setup must name the unusable store");
    await runCommand("enable");
    assert.ok(notices.at(-1)?.includes("The stored key cannot be used."), "enable must not silently accept an unreadable store");
    assert.equal(notices.some(text => text.includes("ts_live_shared_key")), false);
    await runCommand("logout");
    assert.ok(notices.at(-1)?.includes("Removed the stored key at"));
    await runCommand("logout");
    assert.ok(notices.at(-1)?.includes("No stored key to remove."));
  } finally {
    process.env.TYPESAFE_API_KEY = savedKeyNow ?? "offline-test-key";
    await rm(storedPath, { force: true });
  }
});

test("enable without any key tells the operator to log in first and stays closed", async () => {
  const savedKeyNow = process.env.TYPESAFE_API_KEY;
  const savedCustom = customResult;
  try {
    delete process.env.TYPESAFE_API_KEY;
    await runCommand("enable");
    assert.ok(notices.at(-1)?.includes("Run /typesafe login first: no API key is configured."), notices.at(-1));
    await assert.rejects(runTool(), /disabled/, "a refused enable must not open the tool");
    // `setup` with no key is the login flow, which is why the setup report only names a configured or unusable store.
    customResult = undefined;
    await runCommand("setup");
    assert.ok(notices.at(-1)?.includes("Login cancelled; nothing was saved."), notices.at(-1));
  } finally {
    customResult = savedCustom;
    if (savedKeyNow === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = savedKeyNow;
  }
});

test("a host whose notification channel throws never replaces the reported failure", async () => {
  const hostile = {
    hasUI: true,
    ui: {
      notify: () => { throw new Error("notification channel is down"); },
      confirm: async () => true,
      editor: async () => undefined,
      custom: async () => undefined,
      input: async () => { throw new Error("plain input must not be used when custom UI exists"); },
    },
  };
  const savedKeyNow = process.env.TYPESAFE_API_KEY;
  const offline = globalThis.fetch;
  try {
    await runCommand("status", hostile);
    process.env.TYPESAFE_API_KEY = savedKeyNow ?? "offline-test-key";
    process.env.PI_TYPESAFE_ENABLED = "1";
    for (const handler of extension.handlers.get("session_start") ?? []) await Reflect.apply(handler, extension, [{ reason: "startup" }, hostile]);
    globalThis.fetch = async () => Response.json({ error: { message: "invalid key" } }, { status: 401 });
    await assert.rejects(Reflect.apply(tool.definition.execute, tool.definition, [
      "test-call", { state: "synthetic", questions: { yes: { type: "noul", instructions: "Is this synthetic?" } } }, undefined, undefined, hostile,
    ]), /HTTP 401/, "the transport failure must be the error the caller sees");
  } finally {
    globalThis.fetch = offline;
    if (savedKeyNow === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = savedKeyNow;
  }
});

test("status names the cap that stopped requests and when they resume", async () => {
  process.env.PI_TYPESAFE_ENABLED = "1";
  for (const handler of extension.handlers.get("session_start") ?? []) await Reflect.apply(handler, extension, [{ reason: "startup" }, ctx]);
  for (let attempt = 0; attempt < 20; attempt += 1) await runTool();
  await runCommand("status");
  const sessionCapped = notices.at(-1) ?? "";
  assert.ok(sessionCapped.includes("Session 20/20 attempts"), sessionCapped);
  assert.ok(sessionCapped.includes("Cap reached: requestsPerSession 20/20 on"));
  assert.ok(sessionCapped.includes("until a new session starts"));
  const savedPerDay = process.env.PI_TYPESAFE_MAX_REQUESTS_PER_DAY;
  try {
    process.env.PI_TYPESAFE_MAX_REQUESTS_PER_DAY = "1";
    for (const handler of extension.handlers.get("session_start") ?? []) await Reflect.apply(handler, extension, [{ reason: "startup" }, ctx]);
    await assert.rejects(runTool(), /daily request cap reached/);
    await runCommand("status");
    const dayCapped = notices.at(-1) ?? "";
    assert.ok(dayCapped.includes("Session 0/20 attempts"));
    assert.ok(dayCapped.includes("Cap reached: requestsPerDay"));
    assert.ok(dayCapped.includes("until the local day rolls over"));
  } finally {
    if (savedPerDay === undefined) delete process.env.PI_TYPESAFE_MAX_REQUESTS_PER_DAY; else process.env.PI_TYPESAFE_MAX_REQUESTS_PER_DAY = savedPerDay;
  }
});

test("the playground stores its result as a session entry instead of model context", async () => {
  const said: string[] = [];
  const entries: Array<{ customType?: string; data?: { answers?: Record<string, { noul?: number }> } }> = [];
  const renderers = new Map<string, (...args: unknown[]) => { render(width: number): string[] }>();
  const commands = new Map<string, { handler?: (...args: unknown[]) => Promise<unknown> }>();
  const savedKeyNow = process.env.TYPESAFE_API_KEY;
  const savedFetch = globalThis.fetch;
  try {
    process.env.TYPESAFE_API_KEY = "offline-test-key";
    globalThis.fetch = async () => Response.json({ model: "jev-test", answers: { yes: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 5, output_tokens: 1 } });
    const stub = {
      on: () => {},
      sendMessage: (message: { content?: string }) => { said.push(String(message.content)); },
      registerEntryRenderer: (customType: string, renderer: (...args: unknown[]) => { render(width: number): string[] }) => { renderers.set(customType, renderer); },
      appendEntry: (customType: string, data: unknown) => { entries.push({ customType, data: data as { answers?: Record<string, { noul?: number }> } }); },
      registerTool: () => {},
      registerCommand: (name: string, definition: { handler?: (...args: unknown[]) => Promise<unknown> }) => { commands.set(name, definition); },
    };
    typesafeExtension(stub as unknown as ExtensionAPI);
    const handler = commands.get("typesafe")?.handler;
    assert.ok(handler);
    const interactive = {
      hasUI: true,
      ui: {
        notify: (text: string) => { said.push(text); },
        confirm: async () => true,
        editor: async () => JSON.stringify({ state: { message: "synthetic" }, questions: { yes: { type: "noul", instructions: "Is this synthetic?" } } }),
        custom: async () => undefined,
        input: async () => { throw new Error("plain input must not be used when custom UI exists"); },
      },
    };
    await Reflect.apply(handler, null, ["playground", interactive]);
    assert.equal(entries.length, 1, "a submitted playground request becomes one session entry");
    assert.equal(entries[0]?.customType, "typesafe-result");
    assert.equal(entries[0]?.data?.answers?.yes?.noul, 0.9);
    assert.equal(said.some(text => text.includes("P(yes)")), false, "the result must not be pushed back into the transcript");
    const renderer = renderers.get("typesafe-result");
    assert.ok(renderer, "the host's entry renderer is what replays the stored result");
    const replayed = Reflect.apply(renderer, undefined, [{ type: "custom", customType: "typesafe-result", data: entries[0]?.data }, { expanded: false }, {}]).render(200).join("\n");
    assert.ok(replayed.includes("P(yes) = 0.900"), replayed);
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKeyNow === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = savedKeyNow;
  }
});

test("a backend with its own key variable is told to set it, and login never opens", () => {
  // The backend is fixed at module load, so a non-default one needs a fresh process; that child is the only place the
  // specifier is runtime-selected, so its `import()` cannot be static.
  const source = `
    const said = [];
    const commands = new Map();
    const stub = {
      on: () => {},
      sendMessage: (message) => said.push(String(message.content)),
      appendEntry: () => {},
      registerTool: () => {},
      registerCommand: (name, definition) => commands.set(name, definition),
    };
    const mod = await import(${JSON.stringify(resolve("src/extension.ts"))});
    mod.default(stub);
    const handler = commands.get("typesafe").handler;
    const ctx = {
      hasUI: true,
      ui: {
        notify: (text) => said.push(text),
        confirm: async () => true,
        editor: async () => undefined,
        custom: async () => undefined,
        input: async () => { throw new Error("plain input must not be used when custom UI exists"); },
      },
    };
    await handler("logout", ctx);
    await handler("login", ctx);
    await handler("setup", ctx);
    process.env.OPENROUTER_API_KEY = "sentinel";
    await handler("setup", ctx);
    process.stdout.write(JSON.stringify(said));
  `;
  // The child inherits this process's environment, so a real OPENROUTER_API_KEY on the machine would silently change
  // what `/typesafe setup` reports; pin the variable the child should not see.
  const childEnv: NodeJS.ProcessEnv = { ...process.env, PI_TYPESAFE_BACKEND: "openrouter", PI_CODING_AGENT_DIR: temporary };
  delete childEnv.OPENROUTER_API_KEY;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    cwd: process.cwd(),
    env: childEnv,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const said = JSON.parse(result.stdout) as string[];
  assert.ok(said[0]?.includes("OPENROUTER_API_KEY remains managed by your environment"), said[0]);
  assert.ok(said[1]?.includes("Set OPENROUTER_API_KEY securely in your environment"), said[1]);
  assert.ok(said[1]?.includes("uses environment credentials, not /typesafe login"), said[1]);
  assert.ok(said[2]?.includes("Set OPENROUTER_API_KEY securely in your environment"), said[2]);
  // With the variable set, the same backend reports where the key came from instead of how to set it.
  assert.ok(said[3]?.includes("Key configured via OPENROUTER_API_KEY."), said[3]);
});

test("every request this suite makes is served by the in-process stub, and none leaves the process", () => {
  // Declared last: the whole file's traffic has already run through the stub transport, and the guarded fallback has
  // been recording anything that tried to reach the network with a real credential.
  assert.deepEqual(outboundRequests, [], "a request bypassed the stub transport and left the process");
  assert.ok(stubbedRequests.length > 0, "no request reached the stub transport, so this check would prove nothing");
});
