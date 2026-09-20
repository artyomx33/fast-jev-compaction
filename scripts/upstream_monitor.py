#!/usr/bin/env python3
"""Check the approved upstream base once per month and notify a Walkie room."""

from __future__ import annotations

import argparse
import json
import os
from datetime import date, datetime, timezone
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from typing import Any
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen


REPOSITORY = "tamaratran/fast-jev-compaction"
APPROVED_BASE = "e3f262a7f4d42bd8dd32ced30d26176f7cb545b0"
API_ROOT = f"https://api.github.com/repos/{REPOSITORY}"
TIMEOUT_SECONDS = 10


def fetch_json(path: str, *, missing_ok: bool = False) -> Any:
    request = Request(
        f"{API_ROOT}{path}",
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "fast-jev-compaction-upstream-monitor",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        with urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            return json.load(response)
    except HTTPError as error:
        if missing_ok and error.code == 404:
            return None
        raise


def fetch_upstream() -> dict[str, Any]:
    repository = fetch_json("")
    branch = repository.get("default_branch") if isinstance(repository, dict) else None
    if not isinstance(branch, str) or not branch:
        raise ValueError("GitHub response has no default_branch")

    commit = fetch_json(f"/commits/{quote(branch, safe='')}")
    sha = commit.get("sha") if isinstance(commit, dict) else None
    if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-fA-F]{40}", sha):
        raise ValueError("GitHub response has no valid 40-character commit SHA")
    commit_date = commit.get("commit", {}).get("committer", {}).get("date")
    if commit_date is not None and not isinstance(commit_date, str):
        raise ValueError("GitHub response has an invalid commit date")

    release = fetch_json("/releases/latest", missing_ok=True)
    tags = fetch_json("/tags?per_page=1")
    if not isinstance(tags, list):
        raise ValueError("GitHub response for tags is not a list")
    latest_tag = None
    if tags:
        latest_tag = tags[0].get("name") if isinstance(tags[0], dict) else None
        if not isinstance(latest_tag, str):
            raise ValueError("GitHub response has an invalid tag name")
    release_tag = None
    if release is not None:
        release_tag = release.get("tag_name") if isinstance(release, dict) else None
        if not isinstance(release_tag, str):
            raise ValueError("GitHub response has an invalid release tag")

    return {
        "default_branch": branch,
        "head": sha.lower(),
        "head_date": commit_date,
        "latest_release": release_tag,
        "latest_tag": latest_tag,
    }


def atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


def load_status(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    status = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(status, dict):
        raise ValueError(f"status file is not a JSON object: {path}")
    return status


def markdown_text(value: str | None) -> str:
    if value is None:
        return "none"
    return value.replace("\\", "\\\\").replace("`", "\\`").replace("<", "&lt;").replace(">", "&gt;")


def change_signals(upstream: dict[str, Any], previous: dict[str, Any]) -> list[str]:
    signals = []
    if upstream["head"] != APPROVED_BASE:
        signals.append("HEAD differs from the approved base")
    if "latest_release" in previous and upstream["latest_release"] != previous["latest_release"]:
        signals.append("latest release changed")
    if "latest_tag" in previous and upstream["latest_tag"] != previous["latest_tag"]:
        signals.append("latest tag changed")
    return signals


def render_report(upstream: dict[str, Any], previous: dict[str, Any], checked_at: str) -> str:
    signals = change_signals(upstream, previous)
    if signals:
        result = "Review needed: " + "; ".join(signals) + "."
    elif previous:
        result = "No new upstream signal since the previous successful check."
    else:
        result = "Baseline captured; HEAD matches the approved base."
    compare_url = f"https://github.com/{REPOSITORY}/compare/{APPROVED_BASE}...{upstream['head']}"
    return (
        "# Upstream monitor report\n\n"
        f"Checked: {checked_at}\n\n"
        f"Result: **{result}**\n\n"
        f"- Repository: [{REPOSITORY}](https://github.com/{REPOSITORY})\n"
        f"- Default branch: `{markdown_text(upstream['default_branch'])}`\n"
        f"- Approved base: [`{APPROVED_BASE}`](https://github.com/{REPOSITORY}/commit/{APPROVED_BASE})\n"
        f"- Current HEAD: [`{upstream['head']}`](https://github.com/{REPOSITORY}/commit/{upstream['head']})\n"
        f"- Review changes: [compare approved base to HEAD]({compare_url})\n"
        f"- HEAD date: {markdown_text(upstream['head_date'])}\n"
        f"- Latest release: {markdown_text(upstream['latest_release'])}"
        f"{' (baseline)' if not previous else ''}\n"
        f"- Latest tag: {markdown_text(upstream['latest_tag'])}"
        f"{' (baseline)' if not previous else ''}\n\n"
        "This monitor is read-only. Review upstream changes before updating the approved base.\n"
    )


def notify(node: Path, walkie_cli: Path, channel: str, message: str) -> None:
    environment = os.environ.copy()
    environment["WALKIE_ID"] = "codex"
    try:
        subprocess.run(
            [str(node), str(walkie_cli), "send", channel],
            input=message,
            text=True,
            capture_output=True,
            check=True,
            timeout=20,
            env=environment,
        )
    except subprocess.CalledProcessError as error:
        detail = (error.stderr or error.stdout or "no CLI output").strip()
        raise RuntimeError(f"Walkie notification failed (exit {error.returncode}): {detail}") from error


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    home = Path.home()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--channel", required=True, help="Walkie room name")
    parser.add_argument("--state-dir", type=Path, default=home / ".local/state/jev-upstream-monitor")
    parser.add_argument("--node", type=Path, default=home / ".hermes/node/bin/node")
    parser.add_argument(
        "--walkie-cli",
        type=Path,
        default=home / ".hermes/node/lib/node_modules/walkie-sh/bin/walkie.js",
    )
    parser.add_argument("--force", action="store_true", help="check even if this month succeeded")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    state_dir = args.state_dir.expanduser().resolve()
    status_path = state_dir / "status.json"
    report_path = state_dir / "latest.md"
    month = date.today().strftime("%Y-%m")
    try:
        previous = load_status(status_path)
        if not args.force and previous.get("checked_month") == month:
            print(f"upstream already checked successfully for {month}")
            return 0

        upstream = fetch_upstream()
        checked_at = datetime.now(timezone.utc).isoformat()
        signals = change_signals(upstream, previous)
        atomic_write(report_path, render_report(upstream, previous, checked_at))
        headline = "; ".join(signals) if signals else "monthly baseline checked; no new signal"
        message = f"Jev upstream monitor: {headline}.\n\nReport: [{report_path.name}](<{report_path}>)"
        notify(args.node.expanduser(), args.walkie_cli.expanduser(), args.channel, message)
        status = {
            "approved_base": APPROVED_BASE,
            "checked_at": checked_at,
            "checked_month": month,
            "default_branch": upstream["default_branch"],
            "latest_release": upstream["latest_release"],
            "latest_tag": upstream["latest_tag"],
            "report": str(report_path),
            "update_available": bool(signals),
            "upstream_head": upstream["head"],
        }
        atomic_write(status_path, json.dumps(status, indent=2, sort_keys=True) + "\n")
        print(f"monthly upstream check complete: {headline}; report: {report_path}")
        return 0
    except Exception as error:
        print(f"upstream monitor failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
