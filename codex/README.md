# Codex evidence carry-over

This adapter supplements Codex's native compaction. It does not replace, edit, or prune the
transcript. Before compaction, it reads the host-supplied transcript, asks Jev which completed tool
results still contain useful evidence, and stages bounded excerpts. On the following
`SessionStart(source=compact)`, it consumes that staged generation once as `additionalContext`.

The integration is version-scoped to the JSONL records verified in Codex CLI 0.155.1. That format
is not a stable public transcript API. A format or identity mismatch produces a visible local skip
code and lets native compaction continue.

## Build and run

```sh
npm ci
npm run build
node /absolute/path/to/fast-jev-compaction/dist/codex/hook.js \
  --state-dir /absolute/path/to/private/state/jev-codex \
  --key-file /absolute/path/to/private/typesafe.env \
  --model jev-latest
```

The command reads one hook event as JSON on stdin and writes one hook response as JSON on stdout.
`--key-file` must name a local env file containing `TYPESAFE_API_KEY=...`; the key is never accepted
as a command argument. If `--key-file` is omitted, `TYPESAFE_API_KEY` is read from the hook
environment. The state directory and key file should remain outside the repository.

Copy the two command hooks from [hooks.example.toml](hooks.example.toml) into a reviewed Codex
profile and replace its generic absolute paths. Codex hook trust is an installation-time runtime
step; this repository does not mutate global configuration or install itself.

## Supported transcript records

The parser requires one matching `session_meta` record (`payload.id` and canonical `payload.cwd`).
It reads only:

- user `response_item.message` `input_text` for the recent task;
- `response_item.function_call` paired with `function_call_output` by `call_id`;
- `response_item.custom_tool_call` paired with `custom_tool_call_output` by `call_id`.

Function results are strings. Custom results are arrays of `input_text` blocks, joined in their
recorded order with a newline. System, developer, assistant, reasoning, image, malformed,
duplicate, and unpaired records are not candidates. Tool reads of bootstrap instructions, shared
memory, or credential stores are excluded before scoring or persistence. Known key/token formats
and the active TypeSafe key are redacted. This filtering is deliberately narrow and is not a
general PII classifier.

## Limits and behavior

- hook stdin: 64 KiB;
- transcript: 32 MiB streamed, 512 KiB per JSONL line;
- recent completed candidates: 64;
- input excerpt: 500 characters; result excerpt: 2,000 characters (head and tail);
- task text: 3,000 characters;
- 8 candidates per Jev request, at most 8 requests;
- HTTP response: 256 KiB with abort-aware streaming;
- total operation deadline: 20 seconds;
- keep threshold: `noul >= 0.5`, ordered by score then recency;
- complete `additionalContext`: at most 8,000 Unicode characters, with only whole excerpts.

Each question identifies its candidate in the visible instructions, and the Jev state contains the
actual bounded input and result excerpts. Scores must be finite and in `[0,1]`; missing, unknown, or
invalid answers fail the generation without a retry.

Pending state is keyed by session id, canonical working directory, and canonical transcript path.
Every `PreCompact` atomically replaces the current-generation pointer before transcript or network
work. `SessionStart` atomically claims that pointer, validates its identity and 30-minute expiry,
then consumes it once. Directories use mode `0700` and files use `0600`. Status receipts contain
counts, timing, a transcript hash, and a local outcome code; they do not contain transcript text or
the API key.

All failures return either `{}` or a common `systemMessage`; they never request a stop or emit
`continue:false`. Remote response bodies and arbitrary exception text are not copied into stderr,
status, or hook output. Native compaction therefore continues when the adapter cannot add evidence.
An empty Jev selection adds nothing. Because this is additive, it can increase continuation tokens
and latency, and native-only recall can tie it.
