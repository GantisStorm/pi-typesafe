import type { Questions, SystemOneRequest } from "@typesafe-ai/sdk";
import type { Evaluation, TypeSafe } from "./client.js";
import { TypeSafeIntegrationError } from "./errors.js";
import type { IntegrationErrorCode } from "./errors.js";

/** Anything with pi-typesafe's `evaluate`: the real client in a session, a stub in tests. */
export type Judge = Pick<TypeSafe, "evaluate">;

/** Default per-ask deadline; matches the client's own request timeout. */
export const DEFAULT_ASK_TIMEOUT_MS = 15_000;

const FALLBACK_MESSAGE = "TypeSafe request failed.";

export interface AskOptions {
  /** Per-ask deadline, merged with the caller's own signal. Default: DEFAULT_ASK_TIMEOUT_MS. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type AskAnswer<Q extends Questions> =
  | { readonly ok: true; readonly answers: Evaluation<Q>["answers"]; readonly model: string; readonly usage: Evaluation<Q>["usage"]; readonly elapsedMs: number }
  | { readonly ok: false; readonly error: string; readonly errorCode?: IntegrationErrorCode };

/**
 * One typed Jev request that never throws: a failure comes back as `{ ok: false }` with pi-typesafe's own message
 * (which carries no upstream body, header, key, or submitted state) and its code, so a caller can stop asking after a
 * `budget` error. The per-ask timeout is merged into the caller's signal, so either can cancel the request.
 *
 * This is the author-facing "ask Jev" seam. Agents get the same admission through the `typesafe_evaluate` tool; the two
 * share `prepareEvaluationRequest`, so what one accepts the other accepts.
 */
export async function ask<Q extends Questions>(judge: Judge, request: SystemOneRequest<Q>, options: AskOptions = {}): Promise<AskAnswer<Q>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
  // AbortSignal.timeout throws a RangeError outside this function's own catch, which would break the never-throws rule.
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 4_294_967_295) {
    return { ok: false, error: "timeoutMs must be an integer of 1 to 4294967295 milliseconds.", errorCode: "configuration" };
  }
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  try {
    const result = await judge.evaluate(request, { signal });
    return { ok: true, answers: result.answers, model: result.model, usage: result.usage, elapsedMs: result.elapsedMs };
  } catch (error) {
    if (error instanceof TypeSafeIntegrationError) return { ok: false, error: error.message, errorCode: error.code };
    return { ok: false, error: FALLBACK_MESSAGE };
  }
}
