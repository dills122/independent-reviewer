import type { DigestV1 } from "../contracts/index.js";

export type ProviderCallErrorCode =
  | "INVALID_CONFIGURATION"
  | "PROVIDER_ERROR"
  | "INVALID_RESPONSE"
  | "TRANSPORT_UNCERTAIN";

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
}

export interface ProviderCallErrorOptions extends ErrorOptions {
  readonly diagnostic?: ProviderErrorDiagnosticV1;
}

export class ProviderCallError extends Error {
  readonly code: ProviderCallErrorCode;
  readonly diagnostic: ProviderErrorDiagnosticV1 | null;

  constructor(code: ProviderCallErrorCode, message: string, options?: ProviderCallErrorOptions) {
    super(message, options);
    this.name = "ProviderCallError";
    this.code = code;
    this.diagnostic = options?.diagnostic ?? null;
  }
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
}

export interface ReviewProviderRequestAuditV1 {
  providerPolicyVersion: string;
  wireBodyDigest: DigestV1;
  wireBodyBytes: number;
  credentialFreeWireRequestDigest: DigestV1;
}

export interface ReviewProviderV1 {
  auditRequest(request: ReviewProviderRequestV1): ReviewProviderRequestAuditV1;
  complete(request: ReviewProviderRequestV1): Promise<ReviewProviderResponseV1>;
}
