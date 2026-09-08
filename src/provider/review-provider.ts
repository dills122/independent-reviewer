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

export interface ReviewProviderV1 {
  complete(request: ReviewProviderRequestV1): Promise<ReviewProviderResponseV1>;
}
