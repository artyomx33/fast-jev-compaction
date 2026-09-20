# Codex Jev evidence carry-over

## Goal and authority

Artem authorized building our own Codex version after the Claude plugin repeatedly refused destructive pruning. Build, verify and publish a Codex adapter; activate only the tested integration. Existing public-repo/account authorization continues. Native compaction remains the owner of history replacement.

## Baseline and problem

- Repository: artyomx33/fast-jev-compaction, main1883288dcada4040814f6c0393a23a4f9c0ce604, verified2026-09-20. No open PR at recon. Owned worktree ~/projects/jev-codex-carryover, branch codex/jev-carryover.
- Baseline: 41 tests/type checks pass. npm audit reports existing development dependency advisories; no dependencies changed here.
- Original src/state.ts replaces all tool results with size/status notes. Jev therefore cannot inspect the evidence whose retention it judges. This is a concrete input omission; its causal contribution to poor judgments still needs a comparative check.
- Claude receipts: larger transcript keep2/drop580, guard refused; disposable hook fallback retained5/5 through native summary. A quantity guard is not a quality guarantee.
- Codex0.155.1 official hooks: PreCompact cannot replace history; SessionStart(source=compact) may add context before continuation. Local scout confirms raw per-session JSONL still exists in0.155.1; transcript_path may be null and its format is explicitly unstable. Use a version-scoped parser with visible skip on format drift, not a claim of a stable transcript API. Scoped hooks trust and app-server integration will be proven in the lab.

## Design

Use the existing Jev HTTP request/answer primitives, not the original destructive compact() algorithm.

PreCompact -> read host-supplied transcript -> pair completed text tool calls/results -> bounded, redacted excerpts + recent user task -> Jev retention scores -> private atomic pending evidence scoped by session_id + canonical cwd + canonical transcript path.

Native compaction remains unchanged.

SessionStart(source=compact) -> verify exact session, canonical cwd and transcript identity plus short expiry -> consume pending evidence once -> bounded additionalContext containing labeled, quoted observations with provenance. Never turn historical tool text into instructions or authorize actions from it.

### Contracts

- Only host-supplied transcript is read; support only the verified format. Reject malformed/ambiguous identity. Never mutate active transcripts, messages, compacted records or Codex databases.
- Exclude system/developer/reasoning/image content and bootstrap/memory/credential tool reads. Redact known secret formats and the active API key before network, state, or context output. Describe exclusions/limits honestly; filtering is not a universal PII classifier.
- Extract completed tool pairs with id, tool name, input, result and source position. Preserve original text for selected excerpts except explicit clipping/redaction, labeled in provenance. No free-text generation.
- Read ceilings:32MiB transcript (streamed byte count),512KiB per JSONL line,64KiB hook stdin,256KiB HTTP response; abort-aware response reading and a total20second operation deadline. Existing JevClient does not supply these protections: reuse buildJevRequest/parseJevResponse inside the adapter's bounded transport.
- Initial bounds:64 recent candidate pairs, input500chars, result2000chars head/tail, task3000chars,8candidates/request, at most8requests, total operation20seconds. Rank noul>=0.5 by score and recency, whole excerpts only, final additionalContext<=8000characters including wrapper/provenance/JSON encoding. Configure additionalContextLimit:0 to disable host spilling because the adapter itself enforces the complete-output cap. No force-kept minimum and no claim of total retention.
- Questions explicitly identify their target in instructions; request dictionary keys alone are not visible to Jev. Supply actual excerpts and task context in state. Validate every requested score finite and in[0,1]. Empty selection adds nothing.
- Store pending state and a small status receipt under ~/.local/state/jev-codex, directories0700/files0600. Key is environment or a separately configured local .env path, never copied into repository/profile. Receipts contain timings/counts/hash/outcome, no key or raw transcript dumps.
- Storage directory key and pending identity both include session_id, canonical cwd and canonical transcript path; agents sharing parent session_id must never share a slot. Identity-null inputs skip visibly without guessing a transcript. Pending identity also includes creation time and version. Expire after30minutes; mismatch/replay adds no evidence. Each PreCompact starts a UUID generation and atomically updates a current-generation pointer before transcript/API work; ready/error payloads are generation-specific. SessionStart atomically claims the current pointer by rename, reads that claimed generation, validates it and consumes once. A late writer cannot replace another generation. Not-ready/error/expired claims emit an explicit skip. Delivery records attempted consumption, not an unsupported host acknowledgment.
- Jev/read/write/schema errors produce visible local error codes in stderr/status plus common hook systemMessage; never echo raw remote response bodies, arbitrary exception text or data into diagnostics.  continue native compaction. No hidden fake success, no automatic retries, no stop/continue:false response.
- Unsupported hook events or SessionStart startup/resume add nothing. Do not use native compaction replacement fields.

### Placement and signatures

Builder owns src/codex/{transcript,carryover,hook}.ts, tests/codex-*.test.ts, codex/README.md and an installer/example profile if the verified runtime supports it. Use existing build and test tooling, no new packages. Extend only named package scripts if necessary.

parseTranscript(bytes, identity) -> {task,candidates,excluded,clipped}; scoreEvidence(candidates,task,asker,limits) -> selected + scores + receipt; handleHook(event,config,deps) -> documented hook JSON. Pure extraction/scoring is separate from transport and filesystem lifecycle.

Root owns plan, final private receipts, runtime activation, GitHub writes and integration verification. Claude owns his separate plugin changes; do not edit src/compact.ts or the Claude hooks/manifest.

## Work and gates

1. Conductor: confirm hook input/format/trust contract and short independent review over state isolation, source trust and lifecycle. Resolve findings into this plan before build.
2. Builder: implement adapter and meaningful tests. Cover real-shaped call/result parsing, exclusions/redaction, target identity in Jev questions, unknown/missing/out-of-range answers, size/time budgets, no original mutation, session/cwd/transcript mismatch, replay/expiry, failed-precompact stale state removal, native continuation on error, and startup/resume no-op.
3. Conductor: independently review the combined implementation over those invariants. Run real Jev on a predeclared task fixture; preserve selection scores and exact evidence. Compare original metadata-only scoring against evidence-visible scoring without tuning to hidden test answers.
4. Disposable Codex integration: use scoped, reviewed hook configuration. Record real hook events and Jev request, trigger native compaction, prove exact selected evidence reaches immediate continuation and original transcript integrity. Compare native-only and adapter-enabled recall on the same predeclared task. Report tie/regression honestly; do not promise savings from an additive adapter.
5. Publish through a reviewed PR under the existing authorization. Install only the verified scope/config with source hash, rollback command and current-head receipt; no global hook changes until scoped live integration works. If runtime capability cannot support the contract, preserve the complete tested adapter and report that specific limitation.

## Acceptance and limitations

The adapter works only if real Codex consumes its selected excerpts after compaction, API failures preserve native behavior, and identity/secret/replay tests pass. Native-only recall can tie; that does not prove improved recall. An additive evidence supplement can increase tokens/latency and must report its budget. Old facts outside candidate/excerpt limits may be absent.

Impact tier: Broad/unknown (cross-runtime hooks and persistent context). One independent plan review over lifecycle/source boundaries; root did not implement code and supplies implementation review, with focused confirmation after any material fixes. No extra generic review panels.

## Plan review disposition

Independent reviewer codex_plan_review accepted two-hook architecture with version-scoped JSONL reader and visible skip. R1 accepted: explicit stdin/transcript/line/response limits and AbortSignal. R2 accepted: generation pointer and atomic one-shot claim for concurrency/cancellation. R3 accepted: diagnostics use local codes and never echo remote error bodies. R4 accepted: additionalContextLimit0 with complete output cap. R5 accepted: session+canonical cwd+transcript storage identity prevents parent/subagent collisions. These requirements are included above and move into the implementation tests. Native trust activation remains a live-test task, not an assumed setting.
