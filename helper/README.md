# Voice helper

Bento's Dictation, Meetings and Assistant work out of the box with a Gemini API
key (Settings → Dictation → Advanced). Everything else goes through
`voice-helper.py`, a small loopback service that holds the cloud credentials so
the app never does:

- Vertex AI: Gemini Transcribe (batch and live), cleanup and editing models,
  meeting notes, and Gemini 3.8 Live voice calls (`/conversation`).
- Azure OpenAI: GPT Transcribe and the Luna cleanup model (`azure_live.py` also
  carries GPT-Live voice calls; the app runs it directly).
- OpenRouter: MAI-Transcribe-2.
- A local Anthropic-messages gateway (for example LiteLLM): relayed cleanup models.

Parakeet runs on the Mac and needs none of this.

## Setup

1. Copy `voice-runtime.example.json` to `~/.config/bento/voice-runtime.json`,
   `chmod 600` it, and fill it in. Keep it out of dotfiles: it holds the key the
   app and the helper share. The fields:

   | Field | Meaning |
   |---|---|
   | `transport`, `location` | `"direct"` and `"global"` |
   | `bifrost_base_url` | where the helper listens; loopback only, the port is the helper's |
   | `bifrost_key` | shared secret the app sends to the helper |
   | `project`, `model` | Vertex project (it must match your ADC's) and transcription model |
   | `relayed_cleanup_models` | cleanup models offered beside Gemini's, each `{id, name}` |
   | `default_cleanup_model` | cleanup model until one is picked in Settings |
   | `gateway` | `url`, the `models` it serves and the env vars that may hold its key (`key_env`, first set wins) |
   | `azure` | `endpoint` of your Azure OpenAI resource; optional `api_key_env` or `bifrost_config` (a Bifrost config whose Azure key matches the endpoint), and `transcribe_deployment` if GPT Transcribe isn't deployed as `gpt-transcribe` |
   | `env_files` | dotenv files to read keys from (default `~/.hermes/.env`) |
   | `proxy` | optional upstream HTTP proxy; environment proxies are ignored |

   Keys are read on use from the environment, the env files, the Bifrost config
   or Hermes's config (the variable it names for that Azure resource), never
   copied. OpenRouter's key is `BENTO_OPENROUTER_API_KEY` or `OPENROUTER_API_KEY`;
   Azure's can also be `BENTO_AZURE_API_KEY`.
2. Sign in to Google so the helper has application default credentials:
   `gcloud auth application-default login` (or pass a credentials file).
3. `scripts/voice-helper.sh install` creates a virtualenv (Python 3.11+), copies
   the helper next to it (`/opt/homebrew/libexec/bento-voice` when Homebrew
   exists) and runs it as the launchd agent `com.charles.bento.voice-helper`.
   `scripts/voice-helper.sh update` after pulling, `status` to check it,
   `uninstall` to remove it. Logs: `~/Library/Logs/Bento/voice-helper*.log`.

Restart Bento after creating the runtime file or switching between it and an
API key: the transport is chosen at launch. Model lists and other fields are
read on use.

## Assistant

The chat window runs `hermes-acp.py` with Hermes's own Python
(`~/.hermes/hermes-agent/venv/bin/python`). It takes the model, effort and
model list from the `bento_voice` section of `~/.hermes/config.yaml` (an older
`jot_voice` section works too), else Hermes's default model:

```yaml
bento_voice:
  provider: my-provider
  model: my-model
  models: [my-model, other-provider/other-model]
  reasoning_effort: low
```

## Tests

See `tests/README.md`.
