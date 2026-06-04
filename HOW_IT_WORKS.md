# How DevSpend Works — Deep Dive

## tl;dr

DevSpend is a **pure CLI tool** — no daemon, no server, no background process. It reads files that Claude Code (and other AI tools) already write to disk, parses them, and prints reports. Every refresh is on-demand. Nothing runs when you're not looking.

---

## 1. Where Token Data Comes From

You never send data to DevSpend. DevSpend reads data that your AI tools already wrote.

### Claude Code (primary source)

Every time Claude Code gets an API response, it appends one JSON line to a `.jsonl` file:

```
~/.claude/projects/<sanitized-repo-path>/<session-uuid>.jsonl
```

Each line looks like:

```json
{
  "type": "assistant",
  "timestamp": "2026-05-17T10:23:45.123Z",
  "sessionId": "abc-123",
  "cwd": "/Users/you/project",
  "message": {
    "role": "assistant",
    "model": "claude-sonnet-4-6",
    "usage": {
      "input_tokens": 1234,
      "output_tokens": 456,
      "cache_creation_input_tokens": 789,
      "cache_read_input_tokens": 321
    },
    "content": [...]
  }
}
```

DevSpend reads `usage.input_tokens`, `usage.output_tokens`, `usage.cache_creation_input_tokens`, and `usage.cache_read_input_tokens` directly from those lines. The token counts come from Anthropic's API — DevSpend just reads what was already logged.

### Other AI tools

| Tool | Where data lives |
|------|-----------------|
| Cursor | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` (SQLite) |
| Codex | Its own `.jsonl` files |
| OpenCode | SQLite database |
| Cline, Copilot, Gemini, Goose, etc. | Each has a dedicated parser reading that tool's native format |

---

## 2. Data Flow: End to End

```
[AI tool runs a session]
        │
        └─ writes JSONL / SQLite on your local disk
                │
                ▼
[You run `devspend report` or the menubar app polls]
                │
                ▼
        provider/claude.ts
        scans ~/.claude/projects/*/
        returns list of .jsonl files
                │
                ▼
        parser.ts — for each .jsonl file:
          1. fingerprint the file (inode + mtime + size)
          2. check session-cache.json:
             - unchanged  → skip, use cached data
             - appended   → read only the new bytes (incremental)
             - modified   → full re-parse
          3. stream file line-by-line (handles 2 GB files via Buffer)
          4. parse each JSON line → extract tokens, model, tools used
          5. group lines into conversation turns
          6. classify each turn (coding / debugging / refactoring / etc.)
          7. build ProjectSummary with token counts, cost, breakdown by model
          8. write updated cache back (atomic tmp → rename, mode 0o600)
                │
                ▼
        aggregation → DailyEntry[] → cost calculation
        (using bundled litellm pricing snapshot)
                │
                ▼
        output: Ink TUI / JSON / CSV / menubar-json
```

---

## 3. Caching — How It Stays Fast

Four cache files live at `~/.cache/devspend/`:

| File | What it stores | Invalidated by |
|------|---------------|----------------|
| `session-cache.json` | Per-file parsed turn data, keyed by file path | mtime / size / inode change |
| `daily-cache.json` | Per-day aggregates (cost, tokens, models, categories) | 730-day retention window |
| `codex-results.json` | Codex parse results | File change |
| `cursor-results.json` | Cursor SQLite parse results | DB file change |

For **appended** files (the common case — Claude adds lines as a session progresses), DevSpend only reads the new bytes from `lastCompleteLineOffset`. This makes repeated calls very fast even on large session files.

All writes are atomic: write to temp file → fsync → rename. No corrupt cache if the process is killed mid-write.

---

## 4. Background Processes — There Are None

DevSpend has **no daemon, no watcher, no OS-level file subscription (inotify/FSEvents)**. Everything is polling on-demand:

### Terminal TUI (`devspend report`)
`setInterval(() => reloadData(), 30_000)` — re-runs the full parse cycle every 30 seconds inside the Ink (React-in-terminal) UI. Only re-parses files whose fingerprint changed.

### macOS Menubar App
The Swift `NSStatusItem` app periodically spawns:
```sh
devspend status --format menubar-json
```
…as a subprocess, reads stdout as JSON, and renders it in the popover. The menubar app is a separate binary installed at `~/Applications/DevSpendMenubar.app`.

### GNOME Shell Extension
Uses `Gio.SubprocessLauncher` to spawn the same CLI command. Caches the result for 300 seconds before re-invoking.

Neither GUI has a direct file-watching capability. Both rely entirely on re-invoking the CLI.

---

## 5. Cost Calculation

Pricing data is bundled at build time from litellm's pricing snapshot (`src/data/litellm-snapshot.json`). The function `calculateCost()` in `models.ts` multiplies token counts by the per-token rate for each model.

```
cost = (input_tokens × input_rate)
     + (output_tokens × output_rate)
     + (cache_creation_input_tokens × cache_write_rate)
     + (cache_read_input_tokens × cache_read_rate)
```

You can set a custom currency in `~/.config/devspend/config.json` — DevSpend applies an exchange rate multiplier.

---

## 6. Configuration (No Server Needed)

All user config lives at `~/.config/devspend/config.json`:

```json
{
  "currency": "USD",
  "plans": { "anthropic": { "type": "pro", "limit": 20 } },
  "modelAliases": { "my-model": "claude-sonnet-4-6" }
}
```

Commands to configure without editing JSON directly:
```sh
devspend currency EUR          # set display currency
devspend plan set anthropic pro 20   # set plan + budget
devspend model-alias add my-model claude-sonnet-4-6
```

---

## 7. What You Can Customize Without Any Server Changes

Since everything is local file parsing, you can customize:

| What | How |
|------|-----|
| Currency | `devspend currency <code>` |
| Subscription plan / budget alerts | `devspend plan set <provider> <plan> <limit>` |
| Model name aliases | `devspend model-alias add <alias> <real-model>` |
| Cache location | `CODEBURN_CACHE_DIR` env var |
| Auto-refresh interval (TUI) | `devspend report --refresh <seconds>` |
| Date range for reports | `devspend report --days 7` / `--month 2026-04` / `--since` / `--until` |
| Export format | `devspend export --format csv` or `--format json` |
| Per-provider filtering | `--provider claude` / `--provider cursor` etc. |
| Pricing snapshot | Edit `src/data/litellm-snapshot.json` and rebuild (`npm run build`) |
| Adding a new AI tool | Add a file in `src/providers/` implementing the `SessionParser` interface, register in `providers/index.ts` — no server, no daemon needed |

---

## 8. What Requires "Server-Level" Changes

Nothing in the current architecture requires a server. The only scenarios where you'd need one:

- **Sharing data across machines** — currently all data is local; you'd need sync (rsync, a DB, an API)
- **Team-wide dashboards** — aggregating across multiple users would need a central store
- **Real-time streaming** — if you wanted sub-second updates instead of polling, you'd need an inotify/FSEvents watcher process or a WebSocket server

For single-user local use, everything is possible with file edits and CLI flags.

---

## 9. Architecture Diagram

```
Claude Code / Cursor / Codex / …
         │
         │  writes
         ▼
~/.claude/projects/<slug>/*.jsonl       ← one file per session
~/Library/.../Cursor/.../state.vscdb    ← SQLite

         │
         │  read + fingerprint + incremental parse
         ▼
~/.cache/devspend/
  session-cache.json   ← per-file parsed turns (fast re-use)
  daily-cache.json     ← per-day rollups (730d history)
  cursor-results.json
  codex-results.json

         │
         │  aggregate + cost calc
         ▼
~/.config/devspend/config.json   ← your settings (currency, plan, aliases)

         │
         ▼
devspend report      →  Ink TUI (terminal, auto-refresh)
devspend status \
  --format menubar-json  →  JSON to stdout
                              ├─ macOS Swift menubar app (polls CLI)
                              └─ GNOME Shell extension (polls CLI)
```

---

## 10. Key Source Files

| File | What it does |
|------|-------------|
| `src/providers/claude.ts` | Discovers `~/.claude/projects/*/` directories |
| `src/parser.ts` | Core: fingerprinting, incremental parsing, dedup, aggregation |
| `src/session-cache.ts` | Read/write `session-cache.json` |
| `src/daily-cache.ts` | Read/write `daily-cache.json` |
| `src/models.ts` | Pricing table + `calculateCost()` |
| `src/classifier.ts` | Turn classification (coding, debugging, refactoring…) |
| `src/dashboard.tsx` | Ink TUI components |
| `src/config.ts` | Read/write `~/.config/devspend/config.json` |
| `src/providers/index.ts` | Registry of all 21 provider parsers |
