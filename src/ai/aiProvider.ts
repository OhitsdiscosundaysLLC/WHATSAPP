/**
 * The minimal capability the AI service needs from an LLM backend —
 * deliberately not an OpenAI-specific shape, so swapping providers later
 * only means a new `AIProvider` implementation (see `openaiProvider.ts`),
 * never a change to `aiService.ts` or anything that depends on it. Mirrors
 * the `ResponseClassifier`/`MessageSender` dependency-injection pattern
 * already used by the rule engine (see docs/DECISIONS.md ADR-012).
 */
export interface AICompletionRequest {
  /** Hardcoded safety/role policy — never derived from WhatsApp content. */
  systemPolicy: string;
  /** Owner/dashboard-configured instructions — trusted, but still separate from the untrusted user message. */
  ownerConfig: string | undefined;
  /** The untrusted WhatsApp participant's message text. */
  userMessage: string;
  maxOutputTokens: number;
}

export interface AICompletionResult {
  text: string;
  model: string;
  promptTokens: number | undefined;
  completionTokens: number | undefined;
}

export interface AIProvider {
  complete(request: AICompletionRequest): Promise<AICompletionResult>;
}
