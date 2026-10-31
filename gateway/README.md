# DZ23 AI Gateway

Local service that holds the provider credentials and turns every provider into one request/response shape. The
browser (the DZ23 Copilot side panel) never sees an API key: it talks to `127.0.0.1` with a bearer token.

Node standard library only — no dependency, no build.

## Start

```sh
# 1. a token is required: the gateway refuses to start without one
export DZ23_GATEWAY_TOKEN="$(node -e "console.log(require('crypto').randomUUID())")"   # PowerShell: $env:DZ23_GATEWAY_TOKEN = ...
# 2. one key per provider you actually use (see the table below)
export OPENAI_API_KEY="..."
# 3. run
npm run gateway
```

Output: `[dz23-gateway] listening on http://127.0.0.1:8777 — configured providers: openai`
A provider without a key is reported as **not configured**; it is never shown as connected.

Configuration file (optional, gitignored): `gateway/config.json`

```json
{
  "port": 8777,
  "timeoutMs": 60000,
  "rateLimit": { "capacity": 30, "refillPerSecond": 1 },
  "providers": {
    "openai-compatible": { "baseUrl": "http://127.0.0.1:1234/v1", "apiKey": "local", "models": ["my-model"] },
    "openrouter": { "models": ["deepseek/deepseek-chat", "anthropic/claude-sonnet-4"] }
  }
}
```

`apiKey` in the file wins over the environment variable; both stay out of the browser and out of the logs.

## Providers

| id | wire format | credential | notes |
|---|---|---|---|
| `openai` | OpenAI | `OPENAI_API_KEY` | `/chat/completions`, SSE |
| `deepseek` | OpenAI | `DEEPSEEK_API_KEY` | `https://api.deepseek.com/v1` |
| `anthropic` | Anthropic | `ANTHROPIC_API_KEY` | `/messages`, `x-api-key`, `anthropic-version: 2023-06-01` |
| `gemini` | Gemini | `GEMINI_API_KEY` | `:streamGenerateContent?alt=sse`, key in the query (redacted everywhere) |
| `ollama` | OpenAI | none (local) | `http://127.0.0.1:11434/v1`; models must exist locally (`ollama pull qwen3:8b`) |
| `ollama-cloud` | OpenAI | `OLLAMA_CLOUD_API_KEY` | `https://ollama.com/v1` |
| `openrouter` | OpenAI | `OPENROUTER_API_KEY` | set `models` to the full `vendor/model` ids |
| `openai-compatible` | OpenAI | `OPENAI_COMPATIBLE_API_KEY` | requires `baseUrl` + `models` (LM Studio, vLLM, llama.cpp, a proxy) |
| `anthropic-compatible` | Anthropic | `ANTHROPIC_COMPATIBLE_API_KEY` | requires `baseUrl` + `models` |

Every provider supports streaming, cancellation, timeout and error classification. Usage is forwarded when the
provider reports it (`usage` event); nothing is invented when it does not.

## API

All routes except `/health` require `Authorization: Bearer <token>`.

| route | body | answer |
|---|---|---|
| `GET /health` | — | `{ status, providers, configured }` |
| `GET /providers` | — | provider list **without credentials** |
| `POST /chat` | `{ provider?, model?, messages, system?, temperature?, maxTokens?, requestId? }` | `text/event-stream` |
| `POST /cancel` | `{ requestId }` | aborts a running answer |
| `POST /test` | `{ provider, model? }` | real one-token request: `{ ok, provider, model, latencyMs, sample }` |

Stream events (one JSON per `data:` line):

```
{"protocol":1,"type":"start","requestId":"…","provider":"openai","model":"gpt-4o-mini"}
{"protocol":1,"type":"delta","text":"…"}
{"protocol":1,"type":"usage","usage":{"inputTokens":12,"outputTokens":30}}
{"protocol":1,"type":"done","reason":"stop","text":"full answer"}
{"protocol":1,"type":"cancelled","requestId":"…"}
{"protocol":1,"type":"error","error":{"code":"auth_failed","message":"…","provider":"openai"}}
```

Error codes: `unauthorized`, `bad_request`, `unknown_provider`, `provider_not_configured`, `provider_disabled`,
`model_not_available`, `auth_failed`, `rate_limited`, `upstream_error`, `network_error`, `timeout`, `cancelled`,
`invalid_response`. A request that cannot be routed is refused with a JSON error *before* a stream starts.

## Security

- Binds `127.0.0.1` only; a request without the token is rejected, and the gateway refuses to start without one.
- CORS accepts `chrome-extension://*` and `http://127.0.0.1|localhost` only; any other origin gets 403.
- Keys live in the environment or `gateway/config.json` (gitignored). They are redacted from error messages,
  from `/providers`, from `/test` and from every log line (`redact()` in `core.mjs`).
- Logs are JSON lines with method, path, provider, model, duration and error code — never a body or a header.
- Token bucket rate limit (default 30 burst, 1/s), per client address, with `retry-after` on 429.
- Requests are capped at 1 MB, 200 messages and 100 000 characters per message.

## Tests

```sh
npm run test:gateway
```

The suite starts a fake provider that speaks the three wire formats, plus the real gateway, over real HTTP on
loopback: routing, streaming, adapters, auth failure, 500, timeout, cancellation, rate limit, origin refusal,
redaction and the "not configured is not connected" rule. No credential and no external network are needed.

## What this does not do

- No provider is tested against its real API here (no credentials in this environment): a live check is
  `POST /test` with your own key. Until then the integration is *implemented and tested against a simulated
  provider*, not "validated live".
- No model listing endpoint: the model list is configuration. A provider can expose new models before this list
  is updated.

## Provider credentials in a local file (recommended)

`DZ23_PROVIDER_ENV` points to an env file **outside the repository**, so no key ever enters the tree:

```sh
# C:\Users\<user>\.dz23\providers.env
DEEPSEEK_API_KEY=...
ANTHROPIC_API_KEY=...
GEMINI_API_KEY=...
OPENROUTER_API_KEY=...
OLLAMA_API_KEY=...
```

```sh
DZ23_PROVIDER_ENV="C:\Users\<user>\.dz23\providers.env" \
DZ23_GATEWAY_TOKEN="$(node -e "console.log(require('crypto').randomUUID())")" \
npm run gateway
```

The file is parsed at startup (`parseEnvFile` in `core.mjs`: `KEY=VALUE`, `#` comments, optional `export ` and
quotes); the process environment still wins over the file. Nothing from the file is logged, and `/providers`,
`/test` and `/diagnose` never return it — a test pins that. A missing file fails the startup with the path named,
because a silently ignored credential is worse than a clear error.
