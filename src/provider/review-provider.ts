import type { DigestV1 } from "../contracts/index.js";

export type ProviderCallErrorCode =
  | "INVALID_CONFIGURATION"
  | "PROVIDER_ERROR"
  | "INVALID_RESPONSE"
  | "TRANSPORT_UNCERTAIN"
  | "UNPRODUCTIVE_STREAM";

export interface ProviderErrorDiagnosticV1 {
  readonly httpStatus: number;
  readonly providerErrorCode: string;
  readonly providerMessage: string | null;
  readonly errorType: string | null;
  readonly providerCode: string | null;
  readonly providerName: string | null;
  readonly model: string | null;
  readonly responseId: string | null;
  readonly retryAfter: string | null;
  readonly limitSource?: string;
  readonly previousErrors?: Array<{ provider: string | null; code: string | null }>;
}

export interface ProviderCallErrorOptions extends ErrorOptions {
  readonly retryable?: boolean;
  readonly diagnostic?: ProviderErrorDiagnosticV1;
  readonly responseMetadata?: ProviderResponseMetadataV1;
  /** Credential-redacted provider response retained for private failure diagnostics. */
  readonly responseBody?: unknown;
}

export class ProviderCallError extends Error {
  readonly code: ProviderCallErrorCode;
  readonly retryable: boolean;
  readonly diagnostic: ProviderErrorDiagnosticV1 | null;
  readonly responseBody: unknown | null;
  readonly responseMetadata: ProviderResponseMetadataV1 | null;

  constructor(code: ProviderCallErrorCode, message: string, options?: ProviderCallErrorOptions) {
    super(message, options);
    this.name = "ProviderCallError";
    this.code = code;
    this.retryable = options?.retryable ?? false;
    this.diagnostic = options?.diagnostic ?? null;
    this.responseBody = options?.responseBody ?? null;
    this.responseMetadata = options?.responseMetadata ?? null;
  }
}

/** Validated, credential-safe envelope metadata; presence does not mean output was accepted. */
export interface ProviderResponseMetadataV1 {
  readonly responseId: string | null;
  readonly model: string | null;
  readonly provider: string | null;
  readonly finishReason: string | null;
  readonly usage: ReviewProviderResponseV1["usage"];
}

export type ReviewStageV1 = "PRELIMINARY" | "FINAL";

export interface ReviewMessageV1 {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ReviewProviderRequestV1 {
  stage: ReviewStageV1;
  model: string;
  maxOutputTokens: number;
  timeoutMs: number;
  messages: ReviewMessageV1[];
  responseSchema: {
    name: string;
    schema: unknown;
  };
}

export interface ReviewProviderResponseV1 {
  value: unknown;
  rawContent: string;
  responseId: string | null;
  model: string | null;
  provider: string | null;
  usage: {
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
    cost: number | null;
  };
  /** Credential-redacted provider envelope for private attempt diagnostics. */
  rawResponseBody?: unknown;
}

export interface ReviewProviderRequestAuditV1 {
  providerPolicyVersion: string;
  /** Exact endpoint pinned for this attempt, or null when the provider may route. */
  requestedProviderEndpoint?: string | null;
  wireBodyDigest: DigestV1;
  wireBodyBytes: number;
  credentialFreeWireRequestDigest: DigestV1;
}

export interface ReviewProviderV1 {
  /** Pause new requests in the shared batch, including other review workers. */
  deferRequests?(model: string, delayMs: number): void;
  /** Same model and policy; null means no permitted retry target remains. */
  forRetry?(error: ProviderCallError, request: ReviewProviderRequestV1): ReviewProviderV1 | null;
  auditRequest(request: ReviewProviderRequestV1): ReviewProviderRequestAuditV1;
  complete(request: ReviewProviderRequestV1): Promise<ReviewProviderResponseV1>;
}
