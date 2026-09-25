import { ProviderCallError, type ProviderErrorDiagnosticV1 } from "../provider/review-provider.js";
import { chargedTokens } from "./call-accounting.js";
export function normalizedError(error: unknown): {
  name: string;
  code: string | null;
  message: string;
  diagnostic?: ProviderErrorDiagnosticV1;
} {
  if (!(error instanceof Error)) {
    return { name: "UnknownError", code: null, message: "A non-Error value was thrown." };
  }
  const possibleCode = (error as Error & { code?: unknown }).code;
  const normalized: {
    name: string;
    code: string | null;
    message: string;
    diagnostic?: ProviderErrorDiagnosticV1;
  } = {
    name: error.name,
    code: typeof possibleCode === "string" ? possibleCode : null,
    message: error.message,
  };
  if (error instanceof ProviderCallError && error.diagnostic !== null) {
    normalized.diagnostic = error.diagnostic;
  }
  return normalized;
}

/**
 * What a failed attempt costs the run.
 *
 * Charging every failure the full conservative reservation was the reason retries were refused
 * with "the remaining token budget cannot reserve a provider retry": a 429 that never reached a
 * model was billed as if it had produced a whole review. A provider error envelope carrying no
 * usage means no generation happened and costs nothing. Anything else may have generated output,
 * so it keeps the conservative reservation.
 */
export function failedAttemptChargeV1(
  error: ProviderCallError,
  inputTokens: number,
  maxOutputTokens: number,
): { tokens: number; promptTokens: number; completionTokens: number } {
  const usage = error.responseMetadata?.usage;
  const reported = usage ? chargedTokens({ usage }) : null;
  if (reported !== null) {
    return {
      tokens: reported,
      promptTokens: usage?.promptTokens ?? inputTokens,
      completionTokens: usage?.completionTokens ?? 0,
    };
  }
  // A provider error envelope carrying no usage means no generation happened; so does a failure
  // that never reached the provider at all (#134). Both cost nothing.
  if (error.code === "PROVIDER_ERROR" || error.code === "TRANSPORT_UNSENT") {
    return { tokens: 0, promptTokens: 0, completionTokens: 0 };
  }
  return {
    tokens: inputTokens + maxOutputTokens,
    promptTokens: inputTokens,
    completionTokens: maxOutputTokens,
  };
}

/**
 * Base delay before another attempt, or null when the failure is not transient.
 *
 * A rejected request changes nothing on retry: 400/401/402/413/422 need a different request or a
 * different account, so they fail the run immediately instead of burning attempts and money.
 */
export function retryDelayMs(error: ProviderCallError): number | null {
  const code = Number(error.diagnostic?.providerErrorCode);
  const status = error.diagnostic?.httpStatus;
  const transient = [408, 409, 429, 500, 502, 503, 504, 524, 529];
  // An inference call is idempotent for this product: a request that may or may not have been
  // submitted can be reissued, and the ledger charges the uncertain attempt either way. A request
  // that was never submitted is unambiguously safe to reissue and costs nothing (#134).
  if (error.code === "TRANSPORT_UNSENT" || error.code === "TRANSPORT_UNCERTAIN")
    return 1_000 + Math.floor(Math.random() * 1_000);
  if (
    !error.retryable &&
    (error.code !== "PROVIDER_ERROR" ||
      !(transient.includes(code) || (status !== undefined && transient.includes(status))))
  )
    return null;
  const fallbackDelay = () =>
    code === 429 || status === 429 || code === 529 || status === 529
      ? 5_000 + Math.floor(Math.random() * 5_000)
      : 1_000 + Math.floor(Math.random() * 1_000);
  const hint = error.diagnostic?.retryAfter;
  if (!hint) return fallbackDelay();
  const seconds = Number(hint);
  const delay = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(hint) - Date.now();
  // Longer hints remain actionable failures; never retry earlier than the server requested.
  if (!Number.isFinite(delay)) return fallbackDelay();
  return delay <= 30_000 ? Math.max(0, delay) : null;
}
