# Claude Code Status Line — How It Works & How to Customize It

## What Is the Status Line?

The **status line** is a small info bar rendered at the bottom (or top, depending on your terminal) of the Claude Code interface. It updates on every keypress or interaction, giving you real-time context about your session without having to type a command.

In your setup it currently shows things like:
```
[CAVEMAN] | devspend | main | claude-sonnet-4-6 | ctx:87%
```

---

## How It's Wired Up

### The Configuration Entry

In `~/.claude/settings.json`:

```json
"statusLine": {
  "type": "command",
  "command": "bash \"/Users/bharath.bhaktha/.claude/hooks/caveman-statusline.sh\""
}
```

Claude Code reads this config on startup. Every time the status line needs to refresh, it:
1. Spawns that shell command as a subprocess
2. Passes a **JSON blob via stdin** containing live session data
3. Reads whatever the script prints to **stdout**
4. Renders that output (including ANSI color codes) in the status bar

That's the entire protocol. It's just stdin → stdout. No sockets, no daemons.

---

## What Claude Code Sends to Your Script (stdin JSON)

Claude Code injects a JSON object into stdin every time it runs your status line command. The schema looks like this:

```json
{
  "cwd": "/Users/you/projects/myapp",
  "workspace": {
    "current_dir": "/Users/you/projects/myapp"
  },
  "model": {
    "display_name": "claude-sonnet-4-6"
  },
  "context_window": {
    "remaining_percentage": 87.3
  }
}
```

Your script can parse this with `jq` and pull out whatever fields you want to display.

---

## What Your Current Script Does (`caveman-statusline.sh`)

The script runs in several stages:

### Stage 1 — Caveman Mode Badge
```bash
FLAG="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.caveman-active"
```
Reads a flag file at `~/.claude/.caveman-active`. If it exists, prints an orange `[CAVEMAN]` badge with the current mode (lite, full, ultra, etc.). This is how the caveman plugin communicates its state to the status line without any IPC — just a plain file.

**Security hardening built in:**
- Refuses symlinks (blocks path traversal attacks)
- Hard-caps reads at 64 bytes
- Strips everything outside `[a-z0-9-]` (blocks ANSI escape injection)
- Whitelists valid mode values — anything unknown prints nothing

### Stage 2 — Token Savings Suffix
```bash
SAVINGS_FILE="~/.claude/.caveman-statusline-suffix"
```
Reads a pre-rendered savings string written by `caveman-stats.js` so the script doesn't need to shell out to Node.js on every keypress. If the file doesn't exist yet (first install), nothing is shown — no fake numbers.

### Stage 3 — Session Segments from stdin JSON
Reads the JSON piped in by Claude Code and extracts:

| Segment | Field read | Example output |
|---------|-----------|----------------|
| Current directory | `workspace.current_dir` or `cwd` | `| devspend` |
| Git branch | runs `git symbolic-ref --short HEAD` in that dir | `| main` |
| Model name | `model.display_name` | `| claude-sonnet-4-6` |
| Context remaining | `context_window.remaining_percentage` | `| ctx:87%` |

Each segment is printed with ANSI color codes and separated by `|`.

---

## Full Data Flow Diagram

```
[Claude Code UI — every keypress / interaction]
        │
        │  spawns subprocess
        ▼
bash ~/.claude/hooks/caveman-statusline.sh
        │  receives on stdin:
        │  { "cwd": "...", "model": {...}, "context_window": {...} }
        │
        ├─ reads ~/.claude/.caveman-active  →  [CAVEMAN] badge
        ├─ reads ~/.claude/.caveman-statusline-suffix  →  savings string
        ├─ parses stdin JSON via jq  →  dir name, git branch, model, ctx%
        │
        │  prints to stdout:
        │  \033[38;5;172m[CAVEMAN]\033[0m | \033[1;34mdevspend\033[0m | ...
        ▼
[Claude Code renders that string in the status bar]
```

---

## How to Customize It

Since the status line is just a shell script printing to stdout, you can modify `~/.claude/hooks/caveman-statusline.sh` to show anything you want. **No server changes. No rebuilds. No restarts — changes take effect on the next keypress.**

### Example Customizations

#### Add current time
```bash
printf ' | \033[38;5;240m%s\033[0m' "$(date +%H:%M)"
```

#### Add battery level (macOS)
```bash
BATTERY=$(pmset -g batt | grep -o '[0-9]*%' | head -1)
[ -n "$BATTERY" ] && printf ' | \033[38;5;82m🔋%s\033[0m' "$BATTERY"
```

#### Add active Python virtualenv
```bash
[ -n "$VIRTUAL_ENV" ] && printf ' | \033[38;5;226mvenv:%s\033[0m' "$(basename $VIRTUAL_ENV)"
```

#### Add DevSpend daily cost (token spend)
```bash
COST=$(devspend today --format json 2>/dev/null | jq -r '.cost // ""')
[ -n "$COST" ] && printf ' | \033[38;5;196m$%s\033[0m' "$COST"
```
> Note: `devspend` has its own cache so this won't re-parse JSONL files on every keypress — it reads from `~/.cache/devspend/daily-cache.json`.

#### Show number of git commits ahead of remote
```bash
if [ -n "$RAW_CWD" ]; then
  AHEAD=$(git -C "$RAW_CWD" rev-list --count @{u}..HEAD 2>/dev/null)
  [ "$AHEAD" -gt 0 ] 2>/dev/null && printf ' | \033[38;5;214m↑%s\033[0m' "$AHEAD"
fi
```

#### Show last exit code
```bash
# Capture this at the very top of the script before anything else runs
LAST_EXIT="${STATUS_LINE_LAST_EXIT:-}"  # Claude Code may expose this in future
```
(Not yet in the stdin JSON schema, but a natural future addition.)

---

## Replacing the Entire Script

You can point `statusLine.command` at any executable:

```json
"statusLine": {
  "type": "command",
  "command": "/Users/you/.claude/hooks/my-custom-statusline.sh"
}
```

Or use Node.js / Python if you prefer:

```json
"statusLine": {
  "type": "command",
  "command": "node /Users/you/.claude/hooks/statusline.js"
}
```

Rules:
- Print to **stdout** only
- Use **ANSI escape codes** for color (`\033[...m`)
- Parse stdin as JSON to access session data
- Keep it **fast** — it runs on every keypress. Avoid heavy disk reads or network calls in the hot path. Use pre-computed cache files (like the caveman savings file) for anything expensive.
- Exit code doesn't matter; Claude Code only reads stdout

---

## Removing the Status Line

To disable it entirely, remove the `statusLine` key from `~/.claude/settings.json`:

```json
// Remove this block:
"statusLine": {
  "type": "command",
  "command": "..."
}
```

---

## Your Current Setup at a Glance

| Setting | Value |
|---------|-------|
| Config file | `~/.claude/settings.json` |
| Status line script | `~/.claude/hooks/caveman-statusline.sh` |
| Caveman mode flag | `~/.claude/.caveman-active` |
| Savings cache | `~/.claude/.caveman-statusline-suffix` |
| Segments shown | Caveman badge, savings, dir, git branch, model, ctx% |
| Session data source | stdin JSON from Claude Code |
| Refresh trigger | Every keypress / UI interaction |
| Server needed | No |
