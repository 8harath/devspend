<p align="center">
  <img src="assets/logo.png" alt="DevSpend" width="120" />
</p>

<h1 align="center">DevSpend</h1>
<p align="center"><strong>See exactly where your AI coding tokens go.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/devspend"><img src="https://img.shields.io/npm/v/devspend.svg" alt="npm version" /></a>
  <a href="https://github.com/8harath/devspend/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/devspend.svg" alt="license" /></a>
  <a href="https://github.com/8harath/devspend"><img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg" alt="node version" /></a>
  <a href="https://github.com/8harath/devspend/actions"><img src="https://img.shields.io/github/actions/workflow/status/8harath/devspend/ci.yml?label=CI" alt="CI" /></a>
</p>

<p align="center">
  Track token usage and cost across <strong>23 AI coding tools</strong> — Claude Code, Cursor, Copilot, Gemini, Codex, and more.<br/>
  Breaks down spending by directory, project, task type, model, and provider. All local. No API keys.
</p>

---

<p align="center">
  <img src="assets/dashboard.jpg" alt="DevSpend interactive dashboard" width="800" />
</p>

---

## Table of Contents

- [Why DevSpend?](#why-devspend)
- [How It Works](#how-it-works)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Commands](#commands)
  - [report — Interactive Dashboard](#report--interactive-dashboard)
  - [dirs — Directory Breakdown](#dirs--directory-breakdown)
  - [optimize — Waste Scanner](#optimize--waste-scanner)
  - [compare — Model Comparison](#compare--model-comparison)
  - [yield — Productive vs Abandoned Spend](#yield--productive-vs-abandoned-spend)
  - [models — Per-Model Table](#models--per-model-table)
  - [status — One-Liner Summary](#status--one-liner-summary)
  - [export — CSV / JSON Export](#export--csv--json-export)
  - [plan — Subscription Tracking](#plan--subscription-tracking)
  - [currency — Display Currency](#currency--display-currency)
  - [model-alias — Fix Missing Costs](#model-alias--fix-missing-costs)
  - [menubar — macOS App](#menubar--macos-app)
- [Supported Providers](#supported-providers)
- [Task Categories](#task-categories)
- [Filtering & Date Ranges](#filtering--date-ranges)
- [JSON Output](#json-output)
- [Environment Variables](#environment-variables)
- [Native GUIs](#native-guis)
  - [macOS Menubar App](#macos-menubar-app)
  - [GNOME Shell Extension](#gnome-shell-extension)
- [Claude Code Status Line Integration](#claude-code-status-line-integration)
- [Privacy & Data](#privacy--data)
- [Architecture](#architecture)
- [Development Setup](#development-setup)
- [Testing](#testing)
- [Upstream](#upstream)
- [License](#license)

---

## Why DevSpend?

Using multiple AI coding tools daily — Claude Code, Cursor, Codex, Copilot — you get no single place to see what you're actually spending across all of them. Bills pile up with no visibility into which projects, directories, or task types are burning the budget.

**The specific gap that motivated this fork:** knowing *which directory* costs the most tokens. In a monorepo with three projects, you should be able to see "`/api` consumed $8 this week, `/frontend` consumed $3." No existing tool did that across providers.

DevSpend is a fork of [CodeBurn](https://github.com/getagentseal/codeburn) (MIT licensed) with:
- A new `dirs` command — token + cost breakdown by project directory
- Independent identity to extend freely without upstream approval
- Support for additional providers and task categories

If you want the original with active upstream development, use CodeBurn. If you want a fork you can hack on, this is it.

---

## How It Works

DevSpend reads session data directly from disk — the same files your AI tools already write.

```
AI tool runs  →  writes JSONL / SQLite / Protobuf to disk
DevSpend runs →  reads those files  →  prices every token  →  shows breakdown
```

**No daemon, no proxy, no API keys.** Everything is on-demand polling:

1. **Providers** (`src/providers/`) discover and parse tool-specific files (JSONL for Claude Code, SQLite for Cursor, JSON for Gemini, etc.)
2. **Parser** (`src/parser.ts`) fingerprints each file by inode + mtime + size. Unchanged files are skipped entirely. Appended files read only new bytes. Modified files get a full re-parse.
3. **Classifier** (`src/classifier.ts`) assigns one of 13 task categories to every turn, deterministically — no LLM calls.
4. **Pricing** (`src/models.ts`) calculates cost: `(input × rate) + (output × rate) + (cache_write × rate) + (cache_read × rate)`. Rates come from a bundled LiteLLM snapshot updated at build time.
5. **Caches** write atomically (temp file → fsync → rename) to `~/.cache/devspend/` so re-runs are instant.

The terminal TUI re-parses every 30 seconds. The macOS menubar app spawns `devspend status` every 60 seconds. Nothing runs in the background between those polls.

---

## Requirements

- **Node.js 22.13.0 or later**
- At least one supported AI coding tool with session data on disk
- Optional: `better-sqlite3` — auto-installed for Cursor and OpenCode support
- Optional: Swift 6 — only if you want to build the macOS menubar app from source
- Optional: GNOME 45+ — only for the GNOME Shell extension

---

## Installation

**Install globally:**

```bash
npm install -g devspend
```

**Run without installing:**

```bash
npx devspend
```

**From source:**

```bash
git clone https://github.com/8harath/devspend
cd devspend
npm install
npm run build
npm link        # makes `devspend` available globally
```

---

## Quick Start

```bash
devspend                    # interactive dashboard — 7 day window by default
devspend today              # today's usage at a glance
devspend dirs               # which directories are costing you the most
devspend optimize           # find waste, get copy-paste fixes
```

In the interactive dashboard:
- **Arrow keys** or **`1` `2` `3` `4` `5`** — switch between Today / 7 Days / 30 Days / Month / 6 Months
- **`p`** — toggle providers (if multiple AI tools detected)
- **`c`** — open model comparison
- **`o`** — open optimize findings
- **`q`** — quit

---

## Commands

### `report` — Interactive Dashboard

```bash
devspend                                       # default: interactive 7-day dashboard
devspend report                                # same
devspend today                                 # today only (alias)
devspend month                                 # this month (alias)
devspend report -p 30days                      # rolling 30-day window
devspend report -p all                         # every recorded session
devspend report --from 2026-04-01 --to 2026-04-10   # exact date range
devspend report --format json                  # full dashboard data as JSON
devspend report --refresh 60                   # auto-refresh every 60s
devspend report --refresh 0                    # disable auto-refresh
devspend report --provider cursor              # Cursor sessions only
devspend report --project myapp                # filter to one project
```

The dashboard auto-refreshes every 30 seconds by default and shows total token usage (input, output, cache read, cache write), cost, session count, and per-model breakdown.

<p align="center">
  <img src="assets/compare.jpg" alt="Model comparison view" width="700" />
</p>

---

### `dirs` — Directory Breakdown

The feature that motivated this fork. Shows which project directories consumed the most tokens and cost.

```bash
devspend dirs                           # last 30 days, all providers
devspend dirs --period today            # today's directory breakdown
devspend dirs --period week             # last 7 days
devspend dirs --top 10                  # top 10 by cost
devspend dirs --sort tokens             # sort by total token volume
devspend dirs --sort sessions           # sort by session count
devspend dirs --provider claude         # Claude-only spend per directory
devspend dirs --format json             # machine-readable output
```

Example output:

```
  Directory Breakdown  ·  30 days  ·  all providers

  Directory                  Input    Output     Cache   Sessions      Cost
  ─────────────────────────────────────────────────────────────────────────
  Documents/Beta/myapp       1.2M      234K     890.0M        12    $47.23
  Documents/Beta/api-server  543K       89K      80.5M         5    $12.87
  Documents/GitHub/scripts    12K       45K      21.8M         3     $3.54
  ─────────────────────────────────────────────────────────────────────────
  3 directories               1.8M      368K    993.3M        20    $63.64
```

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--period` | `today`, `week`, `30days`, `month`, `all` | `30days` |
| `--provider` | Filter to one provider | all |
| `--sort` | `cost`, `tokens`, `sessions` | `cost` |
| `--top N` | Show only the top N directories | all |
| `--format` | `text`, `json` | `text` |

---

### `optimize` — Waste Scanner

<p align="center">
  <img src="assets/optimize.jpg" alt="Optimize findings panel" width="700" />
</p>

```bash
devspend optimize                       # scan last 30 days
devspend optimize -p today              # today only
devspend optimize -p week               # last 7 days
devspend optimize --provider claude     # Claude sessions only
```

Scans sessions and your `~/.claude/` setup for 14 categories of waste. Each finding includes the estimated savings and a ready-to-paste fix. Findings roll up into an **A–F setup health grade**.

**What it detects:**

| Pattern | Description |
|---------|-------------|
| Duplicate reads | Same file re-read across sessions (same content, wasted context) |
| Junk reads | `.git`, `node_modules`, `dist` pulled into context |
| Low Read:Edit ratio | Editing without reading → more retries |
| Bloated `CLAUDE.md` | Counts `@-import` expansion, flags oversized system prompts |
| Wasted bash output | Uncapped `BASH_MAX_OUTPUT_LENGTH` flooding input tokens |
| Unused MCP servers | Tool schemas in every session for servers never called |
| Ghost agents/skills | Defined in config but never invoked |
| Cache bloat | Cache creation tokens swamping output |
| Low-value expensive sessions | High cost, no productive edits |
| Context bloat | Input:output ratio above 25:1 |
| Unused slash commands | Registered but never used |
| High retry rate | Self-correction burning extra tokens |
| Oversized tool results | Large responses not trimmed |
| Redundant tool calls | Same tool called multiple times in one turn |

---

### `compare` — Model Comparison

```bash
devspend compare                        # interactive model picker
devspend compare -p week                # last 7 days
devspend compare --provider claude      # Claude Code sessions only
```

Side-by-side comparison of any two models across: one-shot rate, retry rate, self-correction rate, cost per call, cost per edit, cache hit rate, and per-category performance (coding, debugging, feature dev, etc.).

---

### `yield` — Productive vs Abandoned Spend

```bash
devspend yield                          # last 7 days
devspend yield -p 30days                # last 30 days
devspend yield --provider claude        # Claude only
```

Correlates AI sessions with git commits by timestamp to classify spend as:
- **Productive** — session led to a commit that landed in the main branch
- **Reverted** — commit was later reverted
- **Abandoned** — session had no matching commit

Requires a git repository in the current directory.

---

### `models` — Per-Model Table

```bash
devspend models                         # last 30 days
devspend models --by-task               # explode each model into per-task-type rows
devspend models --top 10                # top 10 by cost
devspend models --format markdown       # paste-friendly markdown table
devspend models --task feature          # filter to feature-development work
devspend models --provider claude       # filter to one provider
```

**Options:**

| Flag | Description |
|------|-------------|
| `--by-task` | Show each model × task-type combination as its own row |
| `--top N` | Show only top N by cost |
| `--format` | `text` (default), `markdown`, `json` |
| `--task <type>` | Filter to a task type: `coding`, `debugging`, `feature`, etc. |
| `--provider <name>` | Filter to one provider |

---

### `status` — One-Liner Summary

```bash
devspend status                         # compact: today + month
devspend status --format json           # JSON for scripts
devspend status --format menubar-json   # JSON contract for menubar clients
devspend status --provider claude       # Claude only
devspend status --no-optimize           # skip waste scan (faster)
```

Designed for shell prompts, scripts, and the macOS / GNOME menubar clients.

---

### `export` — CSV / JSON Export

```bash
devspend export                         # CSV with today, 7 days, 30 days
devspend export -f json                 # JSON export
devspend export -o ~/usage.csv          # write to file
devspend export --from 2026-04-01 --to 2026-04-30  # date range
devspend export --provider cursor       # filter to one provider
```

---

### `plan` — Subscription Tracking

Track whether your actual API spend is within your subscription plan.

```bash
devspend plan set claude-max                                    # $200/month
devspend plan set claude-pro                                    # $20/month
devspend plan set cursor-pro                                    # $20/month
devspend plan set custom --monthly-usd 200 --provider codex    # custom plan
devspend plan reset --provider codex                           # remove one plan
devspend plan                                                   # show active plans
devspend plan reset                                             # remove all plans
devspend plan --format json                                     # JSON output
```

Plans are stored per provider, so you can track Claude and Cursor simultaneously. Budget progress shows in the dashboard header.

---

### `currency` — Display Currency

```bash
devspend currency GBP           # British Pounds
devspend currency EUR           # Euros
devspend currency AUD           # Australian Dollars
devspend currency               # show current setting
devspend currency --reset       # back to USD
devspend currency --symbol £    # override the display symbol
```

162 currencies supported via [ISO 4217](https://en.wikipedia.org/wiki/ISO_4217#List_of_ISO_4217_currency_codes). Exchange rates from [Frankfurter](https://www.frankfurter.app/) (ECB data, no API key required). Settings stored at `~/.config/devspend/config.json`.

---

### `model-alias` — Fix Missing Costs

If you see `$0.00` for some models, the name reported by your provider doesn't match LiteLLM pricing data (common with proxies or custom deployments).

```bash
devspend model-alias "my-proxy-model" "claude-opus-4-7"   # add alias
devspend model-alias --list                                # show all aliases
devspend model-alias --remove "my-proxy-model"            # remove alias
```

---

### `menubar` — macOS App

```bash
devspend menubar                # install (or launch) the macOS menubar app
devspend menubar --force        # reinstall even if already present
```

Downloads and installs the native macOS menubar app. See [macOS Menubar App](#macos-menubar-app) for details.

---

## Supported Providers

<p align="center">
  <img src="assets/providers.png" alt="All 23 supported providers" width="700" />
</p>

| Provider | Session Data Location | Notes |
|----------|----------------------|-------|
| **Claude Code** | `~/.claude/projects/` | JSONL format, incremental parsing |
| **Claude Desktop** | `~/Library/Application Support/Claude/` | Same JSONL format |
| **Cursor** | `~/Library/Application Support/Cursor/` | SQLite — first run may take ~1 min; cached after |
| **cursor-agent** | Same SQLite as Cursor | Separate agent sessions |
| **Codex (OpenAI)** | `~/.codex/` | JSONL format |
| **GitHub Copilot** | `~/.copilot/` + VS Code workspaceStorage | VS Code format estimates tokens from content length |
| **Gemini CLI** | `~/.gemini/` | JSON per session, real token counts embedded |
| **Mistral Vibe** | `~/.mistral/` | JSONL format |
| **Cline** | VS Code globalStorage | JSONL format |
| **Roo Code** | VS Code globalStorage | JSONL format |
| **KiloCode** | VS Code globalStorage | JSONL format |
| **IBM Bob** | `~/.bob/` | JSONL format |
| **Kiro** | `~/.kiro/` | JSONL format |
| **OpenCode** | `~/.opencode/` | SQLite |
| **OpenClaw** | `~/.openclaw/` | JSONL format |
| **Pi** | `~/.pi/` | JSONL format |
| **OMP (Oh My Pi)** | `~/.omp/` | JSONL format |
| **Droid** | `~/.droid/` | JSONL format |
| **Qwen** | `~/.qwen/` | JSONL format |
| **Kimi Code CLI** | `~/.kimi/` | JSONL format |
| **Goose** | `~/.goose/` | JSONL format |
| **Antigravity** | `~/.antigravity/` | JSONL format |
| **Crush** | `~/.crush/` | JSONL format |

DevSpend **auto-detects** which tools you use. In the dashboard, press **`p`** to toggle between providers when multiple are detected.

**Multi-account Claude:** If you run Claude Code under multiple accounts, point `CLAUDE_CONFIG_DIRS` at all of them:

```bash
CLAUDE_CONFIG_DIRS=~/.claude-work:~/.claude-personal devspend
```

Sessions from all directories are merged into one view per project.

**Adding a new provider** is a single TypeScript file. See `src/providers/codex.ts` for an example. No daemon changes required.

---

## Task Categories

13 categories are automatically classified from tool usage patterns and user message keywords. No LLM calls, fully deterministic — the same session always gets the same classification.

| Category | Trigger |
|----------|---------|
| **Coding** | Edit, Write tools used |
| **Debugging** | Error/fix/broken keywords + tool patterns |
| **Feature Dev** | "add", "create", "implement" in messages |
| **Refactoring** | "refactor", "rename", "simplify", "move" |
| **Testing** | pytest, vitest, jest detected in Bash calls |
| **Exploration** | Read, Grep, WebSearch with no subsequent edits |
| **Planning** | EnterPlanMode, TaskCreate tools used |
| **Delegation** | Agent tool spawns |
| **Git Ops** | git push, commit, merge in Bash |
| **Build/Deploy** | npm build, docker, pm2 detected |
| **Brainstorming** | "brainstorm", "what if", "design" in messages |
| **Conversation** | No tools, pure text exchange |
| **General** | Skill tool or uncategorized |

---

## Filtering & Date Ranges

All commands accept the same filtering flags:

```bash
# Provider filter
devspend report --provider claude
devspend today --provider codex
devspend dirs --provider cursor

# Project filter (directory name substring match)
devspend report --project myapp
devspend month --project api --project web      # multiple projects (OR)
devspend report --exclude node_modules          # exclude a project

# Date range
devspend report --from 2026-04-01 --to 2026-04-30   # exact range
devspend report -p 30days                             # rolling window
devspend report -p all                                # all recorded data

# Period shortcuts
devspend report -p today
devspend report -p week
devspend report -p 30days
devspend report -p month
devspend report -p all
```

`--project` and `--exclude` accept partial matches and can be repeated. They combine with `--provider`.

---

## JSON Output

Every command supports structured output for scripting and integration:

```bash
devspend report --format json
devspend status --format json
devspend dirs --format json
devspend models --format json
devspend plan --format json
devspend export -f json
```

The `menubar-json` format is a compact contract used by the macOS and GNOME clients:

```bash
devspend status --format menubar-json
```

---

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `DEVSPEND_CACHE_DIR` | Override cache directory | `~/.cache/devspend` |
| `DEVSPEND_VERBOSE` | Print parse warnings to stderr | off |
| `DEVSPEND_TZ` | IANA timezone for date grouping | system timezone |
| `CLAUDE_CONFIG_DIRS` | Extra Claude config dirs (colon-separated) | `~/.claude` |

---

## Native GUIs

### macOS Menubar App

<p align="center">
  <img src="assets/menubar-0.8.0.png" alt="macOS menubar app" width="500" />
</p>

A native SwiftUI app that lives in your menu bar. Install with:

```bash
devspend menubar
```

**What it shows:**
- Today's cost + token counts at a glance
- Period selector (Today / 7 Days / 30 Days / Month)
- Provider filter
- Optimize findings (on manual refresh)

**How it works:** Spawns `devspend status --format menubar-json` every 60 seconds. No persistent connection, no background process between polls.

**Build from source:**
```bash
cd mac
swift build -c release
```

Requires Swift 6 and macOS 14 or later.

---

### GNOME Shell Extension

A GNOME Shell panel indicator with a popover UI. Install with:

```bash
cd gnome
chmod +x install.sh
./install.sh
```

Requires GNOME 45 or later (tested through GNOME 50).

**Features:**
- Panel indicator with today's spend
- Popover with period selector and provider filter
- Configurable refresh interval
- Compact mode
- Budget alerts
- Settings dialog via `gnome-extensions prefs devspend`

No build step — plain JavaScript copied to `~/.local/share/gnome-shell/extensions/`.

---

## Claude Code Status Line Integration

DevSpend can feed data into the Claude Code terminal status bar on every keypress.

Add this to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "command": "~/.claude/hooks/devspend-statusline.sh"
  }
}
```

See [STATUSLINE_EXPLAINED.md](STATUSLINE_EXPLAINED.md) for a detailed walkthrough of how the status line works and how to build your own.

Example status bar output:
```
devspend | main | claude-sonnet-4-6 | ctx:87% | today:$2.14
```

---

## Privacy & Data

- **No data leaves your machine.** DevSpend reads files your AI tools already wrote locally and does all analysis on-device.
- **No API keys required.** Pricing uses a bundled LiteLLM snapshot. Exchange rates use the Frankfurter API (ECB public data, no key needed).
- **No telemetry.** DevSpend doesn't phone home, track sessions, or collect usage metrics.
- **Cache stays local.** All caches are in `~/.cache/devspend/` and can be deleted at any time without data loss — they'll be rebuilt on next run.

---

## Architecture

```
src/
├── cli.ts                  Entry point — Commander.js command definitions
├── main.ts                 Command handlers and orchestration
├── parser.ts               Fingerprinting, incremental parsing, aggregation
├── dashboard.tsx           Ink TUI components (interactive dashboard)
├── types.ts                TypeScript interfaces (TokenUsage, SessionSummary, …)
├── classifier.ts           13-category task classifier (deterministic)
├── models.ts               Pricing calculation — cost per token per model
├── optimize.ts             14 waste detectors
├── compare.ts              Model comparison logic
├── yield.ts                Git-correlated analysis
├── config.ts               Config file management (~/.config/devspend/)
├── currency.ts             162-currency conversion via Frankfurter API
├── session-cache.ts        Per-file parsed turn cache (inode/mtime/size keyed)
├── daily-cache.ts          Per-day aggregates (730-day retention)
├── day-aggregator.ts       Session → daily summary rollup
├── export.ts               CSV/JSON formatting
├── cli-date.ts             Date range parsing and period shortcuts
├── menubar-json.ts         JSON contract for macOS / GNOME clients
├── format.ts               formatCost, formatTokens, etc.
├── context-budget.ts       Context window tracking
├── plan-usage.ts           Subscription plan tracking
├── plans.ts                Plan definitions
├── providers/              One file per AI tool integration (27 files)
│   ├── claude.ts           Claude Code / Claude Desktop
│   ├── cursor.ts           Cursor (SQLite)
│   ├── codex.ts            OpenAI Codex
│   ├── copilot.ts          GitHub Copilot (VS Code + legacy CLI)
│   ├── gemini.ts           Google Gemini CLI
│   ├── index.ts            Provider registry (eager + lazy loading)
│   └── …                   22 more providers
└── data/
    └── litellm-snapshot.json   Bundled pricing for all models

mac/                        Native macOS menubar app (Swift 6 + SwiftUI)
gnome/                      GNOME Shell extension (plain JavaScript)
tests/                      42 test files, 568 tests (Vitest)
docs/                       Architecture notes, per-provider data location docs
```

**Key design decisions:**

| Decision | Why |
|----------|-----|
| Local-first, no daemon | Reads files already on disk. No setup, no background process |
| Incremental parsing | Files fingerprinted by inode+mtime+size. Only new bytes read on appends |
| Atomic cache writes | Temp file → fsync → rename. No corruption if process killed mid-write |
| Lazy provider loading | Providers with heavy native deps (SQLite, Protobuf) loaded on demand |
| Deterministic classifiers | Task categories from tool patterns, not LLM calls. Consistent and fast |
| TypeScript strict mode | No `any` without explanation. Bracket-assign forbidden in hot paths |

---

## Development Setup

```bash
git clone https://github.com/8harath/devspend
cd devspend
npm install

# Run in dev mode (no build step needed)
npm run dev -- report
npm run dev -- dirs --top 5
npm run dev -- optimize

# Build
npm run build                   # tsup bundles src/ → dist/cli.js

# Refresh pricing data
npm run bundle-litellm          # fetches latest pricing from LiteLLM repo

# Watch mode
npm run dev -- report --refresh 5
```

The build process:
1. `bundle-litellm.mjs` fetches the latest LiteLLM pricing snapshot → `src/data/litellm-snapshot.json`
2. `tsup` bundles TypeScript to ESM → `dist/cli.js`
3. Adds Node shebang and marks the output executable

`npm publish` runs `prepublishOnly` which triggers `npm run build` automatically.

---

## Testing

```bash
npm test                        # run all 42 test files (568 tests)
npm test -- --watch             # watch mode
npm test -- tests/providers/    # provider tests only
npm test -- tests/parser.test.ts  # single file
```

Test layout:

| Path | Contents |
|------|---------|
| `tests/*.test.ts` | CLI, parser, optimizer, cache, format, models, plans |
| `tests/providers/` | Per-provider parsing tests with real redacted fixtures |
| `tests/security/` | Prototype-pollution guards |
| `tests/fixtures/` | Real-world redacted session data |

CI runs Semgrep to enforce no bracket-assign in hot paths (`src/providers/`, `src/parser.ts`).

---

## Upstream

DevSpend is a fork of [CodeBurn](https://github.com/getagentseal/codeburn) (MIT). The `upstream` remote is kept as a reference for cherry-picking new provider files and pricing data.

```bash
git remote -v
# origin    git@github.com:8harath/devspend.git
# upstream  git@github.com:getagentseal/codeburn.git

# Pull a new provider from upstream
git fetch upstream
git cherry-pick <commit-hash>
```

Brand strings, config paths (`~/.config/devspend/`, `~/.cache/devspend/`), and environment variables (`DEVSPEND_*`) intentionally diverge from upstream.

---

## License

MIT — Copyright (c) 2026 Bharath Bhaktha

Based on [CodeBurn](https://github.com/getagentseal/codeburn) (MIT).
