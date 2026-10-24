// A provider-independent estimate for English prose, not a model tokenizer.
export const DEFAULT_CONTEXT_TOKENS = 100_000;
export const MAX_CONTEXT_TOKENS = 200_000;
export const CONTEXT_CHARS_PER_TOKEN = 4;
export const MAX_CONTEXT_CHARS = MAX_CONTEXT_TOKENS * CONTEXT_CHARS_PER_TOKEN;
export function contextTokens(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.max(1000, Math.min(MAX_CONTEXT_TOKENS, Math.round(number))) : DEFAULT_CONTEXT_TOKENS;
}
