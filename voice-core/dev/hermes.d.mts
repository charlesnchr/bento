export const DEFAULT_REASONING_EFFORT: string;

export interface HermesRequestBody {
  message: string;
  reasoning_effort?: string | null;
  model_options?: Record<string, unknown>;
}

export interface ResolveModelOptionsConfig {
  defaultEffort?: string | null;
  sessionModelOptions?: Record<string, unknown> | null;
}

export function resolveModelOptions(
  body: HermesRequestBody,
  config?: ResolveModelOptionsConfig,
): Record<string, unknown> | null;

export function chatRequestBody(
  body: HermesRequestBody,
  config?: ResolveModelOptionsConfig,
): { message: string; model_options?: Record<string, unknown> };
