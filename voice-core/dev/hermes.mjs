// Hermes chat-request options for the dev server: new VoiceCore sessions default to low
// reasoning effort without blocking explicit overrides on a request.

export const DEFAULT_REASONING_EFFORT = "low";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cleanEffort(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

/**
 * Resolves `model_options` for `POST /api/sessions/{id}/chat/stream`.
 *
 * Hermes's `api_server` does not persist `model_options` on `POST /api/sessions` unless a model
 * lock (`model`/`provider` + `require_model_lock`) is set, so VoiceCore sends `model_options` on
 * each turn instead. New sessions default to `defaultEffort` ("low"); follow-ups inherit the
 * session's options unless the turn specifies an explicit override (`model_options.reasoning_effort`,
 * `model_options.reasoning`, or top-level `reasoning_effort`). Passing `null` or `""` explicitly
 * opts out so Hermes uses its global default.
 */
export function resolveModelOptions(body, { defaultEffort = DEFAULT_REASONING_EFFORT, sessionModelOptions = null } = {}) {
  const inherited = isPlainObject(sessionModelOptions) ? { ...sessionModelOptions } : {};
  const incoming = isPlainObject(body?.model_options) ? body.model_options : null;
  const hasIncomingReasoning = Boolean(incoming && ("reasoning_effort" in incoming || "reasoning" in incoming));
  const hasTopLevelEffort = body != null && "reasoning_effort" in body;

  const options = { ...inherited };
  if (incoming) {
    if (hasIncomingReasoning) {
      delete options.reasoning_effort;
      delete options.reasoning;
    }
    Object.assign(options, incoming);
  }

  if (hasIncomingReasoning) {
    if ("reasoning_effort" in options) {
      const effort = cleanEffort(options.reasoning_effort);
      if (effort) options.reasoning_effort = effort;
      else delete options.reasoning_effort;
    }
  } else if (hasTopLevelEffort) {
    delete options.reasoning_effort;
    delete options.reasoning;
    const effort = cleanEffort(body.reasoning_effort);
    if (effort) options.reasoning_effort = effort;
  } else if (sessionModelOptions === null) {
    const effort = cleanEffort(defaultEffort);
    if (effort) options.reasoning_effort = effort;
  }

  return Object.keys(options).length > 0 ? options : null;
}

/** Builds the JSON body for `POST /api/sessions/{id}/chat/stream`. */
export function chatRequestBody(body, options = {}) {
  const payload = { message: body.message };
  const modelOptions = resolveModelOptions(body, options);
  if (modelOptions) payload.model_options = modelOptions;
  return payload;
}
