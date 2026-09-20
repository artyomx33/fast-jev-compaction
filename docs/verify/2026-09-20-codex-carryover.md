# Codex evidence carry-over verification

Date:2026-09-20. Tier:Broad/unknown, because hooks persist and reintroduce model context. Base1883288; implementation9194332a183444cdf53af3b816081f9ce1990f56. Builder implemented; Codex conductor independently reviewed source/privacy/lifecycle and ran native integration.

## Checks

- Full Vitest64/64:41 unchanged baseline +23 adapter tests. Typecheck and build pass.
- Review fixes: relative bootstrap/credential and actual Graphiti exclusions; injected AGENTS filtering; active and known key formats including quoted JSON values; bounded stream reads; deadline abort/late-result rejection; scoped UUID generations, atomic one-shot claim, expiry and traversal rejection; delivered-count receipts.
- Actual Codex CLI0.155.1 recognized both hooks. Persisted trust granted through its normal hook UI, without bypass flags; hooks/list reported trusted/enabled.
- Real fixture run: one candidate selected, one Jev request,901ms. PreCompact and SessionStart completed. Host hook/completed event contained2,683characters of context starting with the evidence wrapper.
- The pre-compaction transcript prefix and its saved hash remained intact; native records were appended normally.
- Same task, separate native-only and adapter-enabled sessions: both answered5/5 predeclared factual questions. This is an integration success and a recall tie, not demonstrated superiority.
- Controlled input comparison using identical adapter questions: visible result excerpt score0.76 versus omitted excerpt0.64; both selected at0.5. This single probe does not establish causal improvement in selection or statistical reliability.

## Result and limitations

PASS for the tested local adapter and hook-delivery contract. Native compaction remains enabled and owns history. This is an additive evidence supplement, not a replacement compactor or a token-savings claim. Limits64candidate pairs, bounded head/tail excerpts and8,000characters can omit relevant old facts. Filtering covers known bootstrap/credential/memory patterns, not arbitrary PII. Exact native transcript format is version-scoped and may change.

Installation uses an explicit jev profile with a pinned build; ordinary Codex defaults are unchanged. Future broader rollout requires representative real-task evaluation. Private lab transcripts/credentials are excluded from this repository.
