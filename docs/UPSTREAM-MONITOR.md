# Monthly upstream monitor

`scripts/upstream_monitor.py` checks the public
[`tamaratran/fast-jev-compaction`](https://github.com/tamaratran/fast-jev-compaction)
repository against the approved base commit
`e3f262a7f4d42bd8dd32ced30d26176f7cb545b0`. It reads the default branch HEAD,
latest release, and latest tag through GitHub's public API. It does not clone,
install, merge, or modify either repository.

After a successful check, the monitor writes `latest.md` and `status.json`
atomically under `--state-dir`, then records the current month. A normal daily
invocation becomes a no-op after that month's successful run. GitHub or Walkie
failures exit nonzero and do not record success, so the next scheduled run
retries. `--force` runs a manual check even after the monthly gate has closed.

## Manual run

The Walkie channel is required and is deliberately kept out of the public
repository. The message is sent through stdin with `WALKIE_ID=codex`; no room
secret or other credential is written to disk.

```sh
python3 scripts/upstream_monitor.py --channel '<walkie-room>' --force
```

Defaults:

- State: `~/.local/state/jev-upstream-monitor`
- Node: `~/.hermes/node/bin/node`
- Walkie CLI: `~/.hermes/node/lib/node_modules/walkie-sh/bin/walkie.js`
- GitHub request and Walkie subprocess timeouts: 10 and 20 seconds

Override these with `--state-dir`, `--node`, and `--walkie-cli`.

## Daily LaunchAgent

The daily schedule provides retry and catch-up opportunities while the monthly
gate limits successful checks to one per calendar month. `RunAtLoad` also tries
when the agent loads, such as at login. The job can run only while the Mac and
login session are active; a network failure remains visible in stderr and is
retried by the next daily invocation.

Create `~/Library/LaunchAgents/com.example.jev-upstream-monitor.plist` from this
template, replacing every placeholder with an absolute path or the intended
room name. LaunchAgent installation and activation are separate operator steps.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.example.jev-upstream-monitor</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/python3</string>
    <string>/path/to/fast-jev-compaction/scripts/upstream_monitor.py</string>
    <string>--channel</string>
    <string>&lt;walkie-room&gt;</string>
    <string>--state-dir</string>
    <string>/Users/YOU/.local/state/jev-upstream-monitor</string>
    <string>--node</string>
    <string>/Users/YOU/.hermes/node/bin/node</string>
    <string>--walkie-cli</string>
    <string>/Users/YOU/.hermes/node/lib/node_modules/walkie-sh/bin/walkie.js</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>9</integer>
    <key>Minute</key>
    <integer>17</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>/Users/YOU/Library/Logs/jev-upstream-monitor.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/YOU/Library/Logs/jev-upstream-monitor.error.log</string>
</dict>
</plist>
```

The generated `latest.md` is the review artifact linked from the Walkie result.
An `update_available: true` value in `status.json` is a review signal only; the
monitor never updates the approved base or any code.
