# Changelog

## 0.4.0 — 2026-10-18

- No silent drops: `stubMode` `'digest'` (default) / `'line'` / `'none'`; agent ids always kept; full outputs to the per-session ledger `~/.claude/state/compaction-ledger/<sessionId>.jsonl`; `preserveRecentHumanTurns` (hook default 10, the idle-compaction protection); three-line post-compaction notice from the hook.

## 0.3.3 — 2026-09-28

- Fail fast on a stalled Jev origin: 8 s per request, one retry, then fallback.
