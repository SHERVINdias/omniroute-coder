# Provider Configuration Reference

This document covers every provider omniroute-coder can reach, how to set it
up in Settings, and the specifics that differ from the defaults.

---

## How providers work in this app

Every conversation goes through a single outbound path in `src/lib/upstreamRequest.ts`.
That path reads a **provider profile** from `src/lib/providerProfiles.ts` to know
which auth header to send, which URL path the completions endpoint lives at, and
whether a key is required at all.

You configure providers per-account in **Settings → Providers**. Credentials are
encrypted in the local SQLite database and never echo back to the browser after
saving. When you open the API key field on an existing provider, it is blank by
design — leaving it blank on save keeps the stored key intact.

The **active provider** is the one that Chat, Deep Cowork, and Ultra Mode post to.
You can have several providers saved and switch between them.

---

## Provider quick-reference

| Provider | Kind | Auth header | Path suffix | Key required |
|---|---|---|---|---|
| OmniRoute | gateway | `Authorization: Bearer` | (none — include `/v1` in URL) | No |
| Agent Router | external | `Authorization: Bearer` | `/v1` | Yes |
| OpenAI | external | `Authorization: Bearer` | `/v1` | Yes |
| OpenRouter | external | `Authorization: Bearer` | `/api/v1` | Yes |
| Groq | external | `Authorization: Bearer` | `/openai/v1` | Yes |
| Google (Gemini) | external | `Authorization: Bearer` | `/v1beta/openai` | Yes |
| DeepSeek | external | `Authorization: Bearer` | `/v1` | Yes |
| Azure OpenAI | external | `api-key` header | (full deployment URL) | Yes |
| Anthropic | external | `x-api-key` | `/v1` | Yes |
| Ollama | local | (none) | `/v1` | No |
| LM Studio | local | (none) | `/v1` | No |
| llama.cpp | local | (none) | `/v1` | No |
| vLLM | local | (none) | `/v1` | No |
| Custom | external | `Authorization: Bearer` | (as typed) | No |

The "path suffix" column is what the app appends when you supply a bare origin
with no path. If you type a URL that already includes a path, the suffix is not
added.

---

## The OmniRoute gateway

**Base URL:** `http://localhost:20128/v1`

The self-hosted gateway is the original upstream for this app. It multiplexes
across several accounts and exposes combo model ids (`auto`, `mix`, `pool`, etc.)
on top of the concrete ones. No API key is required when it is running locally.

The gateway must be running on your machine for the app to reach it. See
`DEPLOYMENT.md §7` for how to expose it to a hosted deployment via Cloudflare
Tunnel.

Model ids from the gateway are namespaced with a `provider/model` prefix (e.g.
`kiro/claude-sonnet-4-5`). The failover ladder uses that prefix to rotate across
accounts; a bare name cannot be routed.

---

## Hosted providers

### OpenAI

Sign up at platform.openai.com and create an API key under **API Keys**.

**Base URL:** `https://api.openai.com/v1`

Model ids are bare names: `gpt-4o`, `gpt-4o-mini`, `o3`, etc. The `/models`
endpoint returns the live list.

### OpenRouter

OpenRouter is a multi-provider aggregator. One key reaches dozens of upstreams
including Anthropic, Meta, and Mistral models.

**Base URL:** `https://openrouter.ai/api/v1`

Model ids are namespaced with a vendor prefix: `anthropic/claude-sonnet-4-5`,
`meta-llama/llama-3.3-70b-instruct`, etc. The app keeps the full namespaced
name as-is and does not confuse it with a gateway account prefix.

Note the non-standard path. A bare `https://openrouter.ai` will not work;
`/api/v1` is required.

### Groq

**Base URL:** `https://api.groq.com/openai/v1`

Groq's OpenAI-compatible surface lives under `/openai/v1`, not `/v1`. The app
will append `/openai/v1` automatically when you enter a bare origin, but if you
type a URL that already has a path, use the correct path.

### Google (Gemini)

Google's AI Studio key works with their OpenAI-compatibility layer.

**Base URL:** `https://generativelanguage.googleapis.com/v1beta/openai`

Model ids are bare names: `gemini-2.0-flash`, `gemini-2.5-pro`, etc. The
compatibility layer accepts `Authorization: Bearer` with a standard AI Studio key.

The native Google API (`/v1/models/{model}:generateContent`) is a different shape
and is not used here. Pointing the base URL at the native API will not work.

### DeepSeek

**Base URL:** `https://api.deepseek.com/v1`

Standard OpenAI-compatible endpoint. Models include `deepseek-chat` and
`deepseek-reasoner`.

### Azure OpenAI

Azure is the most different from the others. Each deployment has its own URL,
the model name is embedded in that URL, and the key goes in an `api-key` header
rather than `Authorization: Bearer`.

**Base URL:** paste the full deployment URL, which looks like
`https://YOUR-RESOURCE.openai.azure.com/openai/deployments/YOUR-DEPLOYMENT?api-version=2024-10-21`

Because the deployment URL already identifies the model, Azure rejects a
`model` field in the request body. The app deletes it automatically for Azure.

Azure does not publish a `/models` endpoint, so the model list cannot be fetched
automatically. Enter the deployment name in the **Model IDs** field in Settings —
it is the segment between `/deployments/` and `?api-version=` in your URL.

### Agent Router

Agent Router fronts its API with a WAF that rejects requests lacking
browser-shaped headers. The app sends the required headers automatically, so
no extra configuration is needed.

**Base URL:** `https://agentrouter.org`

The path suffix `/v1` is appended automatically when you enter the bare origin.

---

## Local models (no API key required)

Local model servers expose an OpenAI-compatible `/v1` surface, so the app talks
to them exactly like any other provider. No API key is needed because these
servers listen on loopback and accept anonymous requests.

The app does not probe local base URLs with the SSRF guard — that guard is for
public internet endpoints. A local server URL is identified by its hostname
(`localhost`, `127.0.0.1`, a private IP range, or `.local` / `.lan` / `.internal`)
and is allowed through without a DNS resolution check.

### Ollama

Ollama is the most popular way to run open-weight models locally.

**Install:** `https://ollama.com/download`

**Pull a model:**
```
ollama pull llama3.2
ollama pull gemma3:4b
ollama pull qwen2.5:14b
```

**Base URL:** `http://localhost:11434/v1`

Ollama's OpenAI-compatible surface lives under `/v1`. The native Ollama API
at `/api/chat` is a different shape and is not used here.

After pulling at least one model, open Settings in the app, add a new provider
with type **Ollama (local)**, leave the API key blank, and save. The model
list is fetched automatically from `/v1/models`.

### LM Studio

LM Studio provides a GUI for downloading and serving GGUF models.

**Install:** `https://lmstudio.ai`

Start the **Local Server** from the app's left sidebar (the `<->` icon), then
load a model. The server exposes an OpenAI-compatible endpoint.

**Base URL:** `http://localhost:1234/v1`

### llama.cpp

llama.cpp's `llama-server` binary exposes an OpenAI-compatible endpoint.

**Base URL:** `http://localhost:8080/v1`

```
./llama-server -m your-model.gguf --port 8080
```

If you started the server with `--api-key somekey`, put that key in the API
key field in Settings — the app will send it as `Authorization: Bearer`.

### vLLM

vLLM is a high-throughput inference engine designed for GPU servers, but it
also runs on a local machine with a compatible GPU.

**Base URL:** `http://localhost:8000/v1`

```
python -m vllm.entrypoints.openai.api_server \
  --model meta-llama/Llama-3.2-3B-Instruct \
  --port 8000
```

The model id to enter in **Model IDs** is the name you passed to `--model`.
If you started vLLM with `--api-key`, put that key in Settings.

---

## Anthropic (requires a proxy)

Anthropic's native API is **not** OpenAI-compatible. It has no `/chat/completions`
endpoint and uses a different request body shape. Sending an OpenAI-compatible
request to `api.anthropic.com` will return an error or an empty reply.

To use Anthropic models through this app, point it at an OpenAI-compatible proxy
in front of the Anthropic API. Common choices are **LiteLLM**, **one-api**, and
**claude-code-router**. Run the proxy locally and set its base URL as the provider
URL in Settings.

The settings form will warn you when you select the Anthropic type, and the
connection test will refuse rather than send a broken request.

---

## How the failover ladder differs by provider kind

The failover ladder (`buildFailoverLadder` in `src/lib/omniroute.ts`) was designed
for the OmniRoute gateway, which exposes multiple accounts behind a single
endpoint. When a request fails, the ladder rotates to a different account prefix
and retries, which is what `account-retry` steps do.

For external and local providers, there is only one key, so account retries are
capped at one rather than the full gateway value. A request that fails with a 401
or a network error still gets one retry (in case of a transient fault), but the
ladder does not waste turns cycling through accounts that do not exist.

---

## The custom provider type

If you are running any server that speaks the OpenAI chat-completions protocol
and it is not one of the named types above, choose **Custom** and paste the full
URL including the path. The Custom type sends `Authorization: Bearer` and does
not add a path suffix.

---

## Troubleshooting

**"Provider rejected that API key" (401/403).** The key is wrong or expired.
Re-enter it in Settings.

**"Responded but has nothing at that path" (404).** The base URL is missing
a path segment. Check the table at the top of this document for the correct
path suffix for your provider. Groq needs `/openai/v1`, Google needs
`/v1beta/openai`, and OpenRouter needs `/api/v1`.

**"Redirected the request" (3xx).** Usually means the path is missing a segment,
and the server is redirecting to add a trailing slash or to its canonical path.

**Local server returns nothing.** Check that the server is running
(`ollama list`, `lms status`, etc.) and that it has at least one model loaded.
For Ollama: `ollama pull llama3.2` if the list is empty.

**Empty reply from Anthropic.** You are probably pointing directly at
`api.anthropic.com`. Use a proxy — see the Anthropic section above.

**Azure returns an error about an unexpected field.** An older version of this
app sent a `model` field that Azure rejects. The current version deletes it
automatically for Azure. If you are seeing this on a fresh install, check that
`src/lib/upstreamRequest.ts` is up to date.
