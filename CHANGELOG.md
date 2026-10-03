# Changelog

## Unreleased

### GantisStorm fork

- Backend selection now applies to the registered on-demand tool, status,
  credentials, consent text, and test command through `PI_TYPESAFE_BACKEND`.
- OMP hosts without Pi's entry-renderer API retain text test/playground results.
- Added opt-in `typesafe_evaluate_files` for bounded per-file semantic screening:
  8 explicit workspace-relative files, 16 KiB each, per-file probabilities and
  usage, concurrency 3, and the same client/spend budget as supplied-state calls.
- Added pre-upload rejection for unsafe paths, symlinks, hardlinks, binary or
  oversized inputs, duplicate selections, and common credential shapes. These
  checks are conservative screening, not complete DLP or a security sandbox.
- Tool guidance encourages useful proactive semantic offloading while reserving
  facts, calculations, tests, permissions, and runtime proof for deterministic tools.
- Exported `readJudgmentFiles`, `FileState`, and `fileEvaluationSchema` so other
  harness adapters reuse the existing guarded source admission rather than copy it.
- Added a `prepare` script, so npm builds `dist/` when this package is installed
  from git. A consumer can depend on a commit (`git+https://github.com/GantisStorm/pi-typesafe.git#<sha>`)
  instead of a machine-local path; before this, `dist/` was gitignored and absent,
  so a git install shipped no compiled entry points.

### Removed

- `UsageLedger.describe()`. It was reachable only from this package's own tests:
  `/typesafe status` formats the spend report it holds from `getSpend()`, so the
  method was a second copy of that formatting with no caller. Consumers who used
  it can format `UsageReport` and `SpendCaps` the same way the extension does.

### Changed

- The fork's per-request ceiling is 20 questions (`DEFAULT_MAX_QUESTIONS`), matching the shared harness ceiling
  (`~/.bb/jev` and the harness-parity adapter) instead of upstream's 32, so the tool, the chunker, and every adapter
  split at one size. The README, the API reference, and the `usage` string now state 20.
- The owner-only atomic write (mkdir 0700, temp file, chmod 0600, rename, and
  best-effort cleanup) now lives once in `src/atomic.ts` instead of being written
  out in `auth.ts`, `credentials.ts`, and `usage.ts`. Internal only: no export
  changes, and each caller keeps its own error handling.

### Fixed

- **Atomic owner-only writes:** the temporary file is opened `O_CREAT|O_EXCL|O_NOFOLLOW`, so a symlink planted at the
  temp path is refused instead of followed (the write and chmod can no longer land on another file); a stale temp left by
  a crashed process that reused the pid is removed and retried.
- **Admission:** a hostile accessor or a Proxy whose `[[Get]]` throws is a classified `validation` rejection instead of a
  raw `TypeError`, and `prepareEvaluationRequest(value, null)` treats a null options argument as defaults.
- **Schema limits:** question ids (1–100) and Choice labels (1–200) are enforced again through `propertyNames`;
  `Type.Record` had compiled its key schema away, so `Check` admitted empty and over-long keys.
- **Guarded file admission:** an absent, unreadable, or non-file selection is a
  classified `validation` rejection instead of a raw filesystem error that carried
  the resolved absolute path; two spellings of one path on a case-insensitive
  volume count as one selection; and `typesafe_evaluate_files` normalizes the
  same near-miss aliases as `typesafe_evaluate` before Pi's own argument
  validation, which had rejected them first.
- **Batching:** each request is admitted by `evaluate`, so a client configured
  with a non-default `maxInputBytes` no longer has the batch refuse a request
  `evaluate` accepts; a `stopOn` rule that throws, or a non-finite `concurrency`
  or `maxQuestions`, no longer breaks the never-throwing, never-silently-skipped
  guarantees.
- **Spend accounting:** tokens billed for a response that fails response
  validation now reach the session counters and the daily ledger, so the token
  and spend caps see them.
- **API:** `getSpend().blocked` reports a reached session cap as
  `requestsPerSession` (a new `BlockedCap["cap"]` member) instead of reporting
  nothing while the next `evaluate` is refused, and it no longer hides a reached
  daily cap; `UsageLedger.recordFailure` accepts the input/output tokens a failed
  request still billed.
- **Configuration:** a non-finite `maxInputBytes` or `usdPerMTok`, an
  out-of-range `ask` deadline, a caller endpoint `keyEnv` naming an
  `Object.prototype` member such as `toString`, and a non-string `apiKey` are
  refused with a classified error instead of being ignored, thrown raw, or
  silently reading a function.
- **Credentials:** a key store that cannot finish removes its temporary file
  instead of leaving the plaintext key behind, and an unremovable stored key is a
  classified `configuration` error.
- **Calibration:** a threshold limit below 2 no longer returns `[undefined]`,
  which crashed `formatCalibration`.
- **Extension:** `PI_TYPESAFE_BACKEND` that is empty or whitespace falls back to
  the default backend instead of failing the extension at import (an unknown name
  still fails), and output the host cannot deliver no longer turns a reported
  failure into a thrown one.

## 0.8.0

### Added

- A `commandcode` backend for the same Jev decisions protocol: `createTypeSafe({ backend: "commandcode" })` sends judgments to `api.commandcode.ai` under `/provider/v1/systemone` with the key from `COMMANDCODE_API_KEY` and the model `typesafe/jev`; its public model list does not verify a key.
- `backend` accepts a caller-supplied endpoint object wherever a backend name is accepted (`createTypeSafe`, `keySituation`, `resolveApiKey`, `authState`, `ensureApiKey`, `safeError`): an endpoint names its own `label`, `host`, `keyEnv`, and optionally `path`, `defaultModel`, and model-list fields, is validated on every call, never reads `TYPESAFE_API_KEY` or the login store, and is never added to the registry. An invalid backend makes `authState` and `keySituation` throw `configuration`; validate user input with `resolveBackend` first.
- `resolveBackend(nameOrEndpoint)` resolves either form to the validated backend the client uses, and `backendHost(nameOrEndpoint)` reports the destination host for consent text, alongside the `BackendEndpoint`, `BackendSpec`, and `ResolvedBackend` types.
- `TypeSafeBackend` now includes `"commandcode"`; a consumer with an exhaustive `switch` over it sees a new member.

## 0.7.4

### Fixed

- A bare Jev model id is mapped to the backend's own form before it is sent — on OpenRouter `jev-latest` goes as `~typesafe/jev-latest` and `jev-1.13` as `typesafe/jev-1.13`, for the client default and a per-request `model` alike — so OpenRouter no longer answers 400, and `/typesafe status` reports the model the configured backend actually sends.

## 0.7.3

### Changed

- Dependency updates: `typebox` 1.3.31 to 1.3.34 (runtime); `typescript` 6.0.3 to 7.0.2, `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` 0.85.1 to 0.86.1, `@types/node` 22.20.3 to 22.20.4, and `tsx` 4.23.13 to 4.23.15 (development). No change to the public API.

## 0.7.2

### Fixed

- HTTP advice is backend-aware: `safeError(error, backend?)` names the backend's key variable on a 401 (`Check OPENROUTER_API_KEY.` on OpenRouter, `Check TYPESAFE_API_KEY.` by default), a 402 now says `Insufficient credits. Add credits at https://openrouter.ai/credits.` on OpenRouter and `Check your account balance.` elsewhere without marking the key unusable, and a 429 appends `Retry after <n> seconds.` when the response carries a numeric `Retry-After` header. One-argument `safeError` calls are unchanged.

## 0.7.1

### Fixed

- `listModels()` asks each backend for its own model list. It requested the SDK's `/v1/models` on every backend, so on OpenRouter it fetched an HTML page and always failed; it now uses `/api/v1/models` and reads the list from OpenRouter's `data` field (#11).
- `listModels()` on OpenRouter returns model ids (`vendor/model`), the values `model:` accepts, instead of display names.
- A public model list no longer proves a key. OpenRouter serves its list without checking the key, so a successful `listModels()` there leaves `authState({ backend: "openrouter" })` unverified rather than recording a garbage key as verified.

### Added

- `BackendConfig` gains optional `modelsPath`, `modelsField`, `modelsIdField`, and `modelsVerifyKey`, documented in the API reference.

## 0.7.0

### Fixed

- Key reporting and login can name the judgment backend: `keySituation(backend)`, `resolveApiKey(backend)`, `authState({ backend })`, and `ensureApiKey(ctx, { backend })` read the backend's own environment variable, `describeAuth` labels the key by backend and names the variable to set, and `AuthState` carries `backend`. Before, every surface reported the TypeSafe key, so an OpenRouter user saw "TypeSafe key: missing" while judgments ran, and `ensureApiKey` opened the TypeSafe login and verified the pasted key against api.typesafe.ai (#9).
- `createTypeSafe({ backend: "openrouter" })` no longer falls back to `TYPESAFE_API_KEY` or the login store when `OPENROUTER_API_KEY` is unset; a TypeSafe key was being sent to OpenRouter.

### Added

- `DEFAULT_BACKEND` export and a `label` on every `DECISIONS_BACKENDS` entry.

### Docs

- Document the `backend` option, `DECISIONS_BACKENDS`, and which key each backend reads in the README and the API reference; the OpenRouter backend shipped in 0.6.0 without either.

## 0.6.2

### Fixed

- Describe every field the agent authors in the `typesafe_evaluate` schema (`state`, `questions`, `type`, `instructions`, `criteria`, `model`) and show one request payload in the prompt guidelines, so the first call no longer has to fail to learn the shape (#6, #7).

## 0.6.1

### Fixed

- Send OpenRouter judgments to `/api/alpha/decisions` instead of the TypeSafe SDK's default `/v1/systemone` path, while preserving caller-supplied transports (#2).
- Keep the lockfile's root package version aligned with the published package.
- Build declarations before checking public-API examples so `npm run check` works from a clean checkout.

### Added

- Contributor CI for supported Node versions on Linux and macOS, workflow lint, installed-package smoke tests, and a combined `CI passed` check.
- Verified package artifacts, tag-triggered draft GitHub releases, weekly dependency updates, and contributor/release guidance; npm publication remains manual.

## 0.6.0

### Added

- `backend` option on `TypeSafeOptions` to route judgments to different services (`"typesafe"` or `"openrouter"`).
- `DECISIONS_BACKENDS` registry mapping backend names to `{ host, keyEnv }` configs.
- Backend-specific env var resolution: `OPENROUTER_API_KEY` for openrouter, `TYPESAFE_API_KEY` for typesafe.
- Default model changes per backend: `jev-latest` for typesafe, `typesafe/jev-1.13` for openrouter.

## 0.5.0

- Initial tracked release.
