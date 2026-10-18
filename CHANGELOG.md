# Changelog

## 0.4.1 — 2026-10-18

- Hook default `preserveRecentHumanTurns` 10 → 3 (owner pick; at 10 none of 13 measured compaction points had anything to drop).
- `onNothingToDrop: 'skip' | 'native'` (hook, default `'skip'`): when the recent-human-turn window leaves no candidate, or widens the pinned tail and the reduction stays below `minReductionRatio`, the hook returns `{ skip }` (conversation unchanged, one line "Compaction skipped by Jev at <ts>: <N> recent human turns pinned, nothing older to drop.") instead of the built-in summary.

## 0.4.0 — 2026-10-18

- No silent drops: `stubMode` `'digest'` (default) / `'line'` / `'none'`; agent ids always kept; full outputs to the per-session ledger `~/.claude/state/compaction-ledger/<sessionId>.jsonl`; `preserveRecentHumanTurns` (hook default 10, the idle-compaction protection); three-line post-compaction notice from the hook.

## 0.3.3 — 2026-09-28

- Fail fast on a stalled Jev origin: 8 s per request, one retry, then fallback.
