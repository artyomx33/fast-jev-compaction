import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from scripts import upstream_monitor as monitor


UPSTREAM = {
    "default_branch": "main",
    "head": "a" * 40,
    "head_date": "2026-09-19T12:00:00Z",
    "latest_release": "v1.2.0",
    "latest_tag": "v1.2.1",
}


class UpstreamMonitorTests(unittest.TestCase):
    def test_same_month_skips_api_and_notification(self):
        with tempfile.TemporaryDirectory() as directory:
            state_dir = Path(directory)
            month = monitor.date.today().strftime("%Y-%m")
            (state_dir / "status.json").write_text(json.dumps({"checked_month": month}))
            with patch.object(monitor, "fetch_upstream") as fetch, patch.object(monitor, "notify") as notify:
                result = monitor.main(["--channel", "room", "--state-dir", directory])
            self.assertEqual(result, 0)
            fetch.assert_not_called()
            notify.assert_not_called()

    def test_changed_head_writes_report_and_success_status(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(monitor, "fetch_upstream", return_value=UPSTREAM), patch.object(monitor, "notify"):
                result = monitor.main(["--channel", "room", "--state-dir", directory])
            self.assertEqual(result, 0)
            report = (Path(directory) / "latest.md").read_text()
            status = json.loads((Path(directory) / "status.json").read_text())
            self.assertIn("Review needed", report)
            self.assertIn("a" * 40, report)
            self.assertIn("compare/" + monitor.APPROVED_BASE + "..." + "a" * 40, report)
            self.assertTrue(status["update_available"])
            self.assertEqual(status["upstream_head"], "a" * 40)
            self.assertEqual(status["latest_tag"], "v1.2.1")

    def test_new_tag_on_approved_head_is_reported_after_baseline(self):
        with tempfile.TemporaryDirectory() as directory:
            state_dir = Path(directory)
            previous = {
                "checked_month": "2000-01",
                "latest_release": "v1.2.0",
                "latest_tag": "v1.2.0",
            }
            (state_dir / "status.json").write_text(json.dumps(previous))
            current = {**UPSTREAM, "head": monitor.APPROVED_BASE}
            with patch.object(monitor, "fetch_upstream", return_value=current), patch.object(
                monitor, "notify"
            ) as notify:
                result = monitor.main(["--channel", "room", "--state-dir", directory])
            self.assertEqual(result, 0)
            report = (state_dir / "latest.md").read_text()
            status = json.loads((state_dir / "status.json").read_text())
            self.assertIn("latest tag changed", report)
            self.assertTrue(status["update_available"])
            self.assertIn("latest tag changed", notify.call_args.args[3])

    def test_http_failure_does_not_mark_month_successful(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(monitor, "fetch_upstream", side_effect=OSError("offline")):
                result = monitor.main(["--channel", "room", "--state-dir", directory])
            self.assertEqual(result, 1)
            self.assertFalse((Path(directory) / "status.json").exists())

    def test_notification_failure_does_not_mark_month_successful(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(monitor, "fetch_upstream", return_value=UPSTREAM), patch.object(
                monitor, "notify", side_effect=RuntimeError("not delivered")
            ):
                result = monitor.main(["--channel", "room", "--state-dir", directory])
            self.assertEqual(result, 1)
            self.assertTrue((Path(directory) / "latest.md").exists())
            self.assertFalse((Path(directory) / "status.json").exists())

    def test_walkie_message_uses_stdin_without_a_shell(self):
        completed = subprocess.CompletedProcess([], 0, stdout="queued", stderr="")
        with patch.object(monitor.subprocess, "run", return_value=completed) as run:
            monitor.notify(Path("/node"), Path("/walkie.js"), "room", "value: $(unsafe)")
        args, kwargs = run.call_args
        self.assertEqual(args[0], ["/node", "/walkie.js", "send", "room"])
        self.assertEqual(kwargs["input"], "value: $(unsafe)")
        self.assertNotIn("shell", kwargs)
        self.assertEqual(kwargs["env"]["WALKIE_ID"], "codex")


if __name__ == "__main__":
    unittest.main()
