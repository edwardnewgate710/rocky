/**
 * @packageDocumentation
 * One translation from provider failure to HTTP, shared by every feature that calls a provider.
 *
 * Extracted from `move-explanation-service.ts` when tournament commentary became the second caller
 * (ADR-0130). The alternative was a second copy differing only in the noun, and the last time this
 * codebase kept two hand-maintained copies of one rule they drifted — three copies of the UCI shape
 * filter, collapsed in ADR-0129 §6b. The subject is a parameter precisely so the copy cannot
 * reappear.
 */
import { AiError } from '@chess-platform/ai-orchestrator';

import { HttpError } from '../http/errors.js';

/**
 * Translate an AI failure into the API's error vocabulary.
 *
 * Every branch returns a fixed string built from `subject` alone. `AiError.message` is built from
 * the provider's own response body — `openai-adapter.ts` reads `error.message` straight out of it —
 * so interpolating it here would forward a third party's error text, and with it whatever that
 * vendor chose to say about our account, our key prefix, our organisation or our quota. The client
 * learns that the feature is unavailable and nothing about who was supposed to serve it.
 *
 * Everything is a 503 rather than a 500 because none of these is the caller's fault and all of them
 * are worth retrying later; `auth_failed` in particular is a deployment misconfiguration, and
 * telling the caller "unauthorized" would be a lie about *their* credentials.
 *
 * Anything that is not an `AiError` is returned untouched so a genuine bug surfaces as a 500 instead
 * of being disguised as a temporary provider problem — the same rule `analysis/service.ts` follows.
 *
 * @param err - the thrown value.
 * @param subject - the feature name to put in the message, e.g. `move explanation`.
 * @returns an `HttpError` for a provider failure, or `err` unchanged for anything else.
 */
export function aiErrorToHttp(err: unknown, subject: string): unknown {
  if (err instanceof HttpError) return err;
  if (!(err instanceof AiError)) return err;

  switch (err.code) {
    case 'provider_timeout':
      return new HttpError(503, 'service_unavailable', `${subject} timed out`, undefined, {
        'Retry-After': '5',
      });
    case 'rate_limited':
      // The *provider* rate-limited us, not the user. A 429 here would tell the caller to slow down
      // about a ceiling they have no way to see and did not exceed.
      return new HttpError(503, 'service_unavailable', `${subject} is temporarily unavailable`, undefined, {
        'Retry-After': '30',
      });
    case 'no_provider':
    case 'provider_unavailable':
    case 'circuit_open':
      return new HttpError(503, 'service_unavailable', `${subject} is temporarily unavailable`, undefined, {
        'Retry-After': '30',
      });
    case 'cancelled':
      return HttpError.unavailable(`${subject} was cancelled`);
    default:
      // Including `auth_failed`, `provider_error`, `invalid_response`, `context_too_long`,
      // `content_filtered`, `budget_exceeded` and `config_error` — all deployment- or vendor-side,
      // none of them the caller's business, and every one of them carrying a message worth not
      // forwarding.
      return HttpError.unavailable(`${subject} is unavailable`);
  }
}
