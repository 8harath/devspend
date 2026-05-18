<p align="center"><strong>DevSpend — See where your AI coding tokens go.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/devspend"><img src="https://img.shields.io/npm/v/devspend.svg" alt="npm version" /></a>
  <a href="https://github.com/8harath/devspend/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/devspend.svg" alt="license" /></a>
  <a href="https://github.com/8harath/devspend"><img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg" alt="node version" /></a>
</p>

DevSpend tracks token usage, cost, and performance across **23 AI coding tools**. It breaks down spending by directory, task type, model, tool, project, and provider so you can see exactly where your budget goes.

Everything runs locally. No wrapper, no proxy, no API keys. DevSpend reads session data directly from disk and prices every call using [LiteLLM](https://github.com/BerriAI/litellm).

---

## Why DevSpend?

I use multiple AI coding tools every day — Claude Code, Cursor, Codex, Copilot — and had no single place to see what I was actually spending across all of them. The bills kept piling up with no visibility into which projects, directories, or task types were burning the budget.

**The specific gap that triggered this:** I wanted to know *which directory* was costing me the most tokens. A monorepo where I work on three projects simultaneously should tell me "your `/api` folder consumed $8 this week, `/frontend` consumed $3." No existing tool did that across providers.

DevSpend is a fork of [CodeBurn](https://github.com/getagentseal/codeburn) (MIT licensed) with:
- A new `dirs` command — token + cost breakdown by project directory, sortable by cost, tokens, or sessions
- My own identity so I can extend it freely without upstream approval
- Clean ground to add features specific to how I work

If you want the original with active upstream development, use CodeBurn. If you want a fork you can hack on, this is it.

---

## Requirements

- Node.js 22+
- At least one supported AI coding tool with session data on disk
- For Cursor and OpenCode support, `better-sqlite3` is installed automatically as an optional dependency

## Install

```bash
npm install -g devspend
```

Or run directly without installing:

```bash
npx devspend
```

## Usage

```bash
devspend                        # interactive dashboard (default: 7 days)
devspend today                  # today's usage
devspend month                  # this month's usage
devspend report -p 30days       # rolling 30-day window
devspend report -p all          # every recorded session
devspend report --from 2026-04-01 --to 2026-04-10  # exact date range
devspend report --format json   # full dashboard data as JSON
devspend report --refresh 60    # auto-refresh every 60s (default: 30s)
devspend status                 # compact one-liner (today + month)
devspend status --format json
devspend export                 # CSV with today, 7 days, 30 days
devspend export -f json         # JSON export
devspend dirs                   # token + cost by project directory
devspend dirs --period today    # today's directory breakdown
devspend dirs --top 10          # top 10 dirs by cost
devspend dirs --sort tokens     # sort by total token volume
devspend dirs --provider claude # Claude-only spend per directory
devspend dirs --format json     # machine-readable output
devspend optimize               # find waste, get copy-paste fixes
devspend optimize -p week       # scope the scan to last 7 days
devspend compare                # side-by-side model comparison
devspend yield                  # track productive vs reverted/abandoned spend
devspend yield -p 30days        # yield analysis for last 30 days
devspend models                 # per-model token + cost table (last 30 days)
devspend models --by-task       # explode each model into per-task-type rows
devspend models --top 10        # only the top 10 by cost
devspend models --format markdown      # paste-friendly markdown table
devspend models --task feature         # filter to feature-development work
devspend models --provider claude      # filter to one provider
```

Arrow keys switch between Today, 7 Days, 30 Days, Month, and 6 Months (use `--from` / `--to` for an exact historical window). Press `q` to quit, `1` `2` `3` `4` `5` as shortcuts, `c` to open model comparison, `o` to open optimize. The dashboard auto-refreshes every 30 seconds by default (`--refresh 0` to disable).

## Supported Providers

| Provider | Supported |
|----------|-----------|
| Claude Code | Yes |
| Claude Desktop | Yes |
| Cline | Yes |
| Codex (OpenAI) | Yes |
| Cursor | Yes |
| cursor-agent | Yes |
| Gemini CLI | Yes |
| Mistral Vibe | Yes |
| GitHub Copilot | Yes |
| IBM Bob | Yes |
| Kiro | Yes |
| OpenCode | Yes |
| OpenClaw | Yes |
| Pi | Yes |
| OMP (Oh My Pi) | Yes |
| Droid | Yes |
| Roo Code | Yes |
| KiloCode | Yes |
| Qwen | Yes |
| Kimi Code CLI | Yes |
| Goose | Yes |
| Antigravity | Yes |
| Crush | Yes |

DevSpend auto-detects which AI coding tools you use. If multiple providers have session data on disk, press `p` in the dashboard to toggle between them.

The `--provider` flag filters any command to a single provider: `devspend report --provider claude`, `devspend today --provider codex`, `devspend export --provider cursor`. Works on all commands: `report`, `today`, `month`, `status`, `export`, `optimize`, `compare`, `yield`, `dirs`.

### Provider Notes

**Cursor** reads token usage from its local SQLite database. Since Cursor's "Auto" mode hides the actual model used, costs are estimated using Sonnet pricing (labeled "Auto (Sonnet est.)" in the dashboard). First run on a large Cursor database may take up to a minute; results are cached and subsequent runs are instant.

**Gemini CLI** stores sessions as single JSON files. Each session embeds real token counts (input, output, cached, thoughts) per message, so no estimation is needed.

**GitHub Copilot** reads from both `~/.copilot/session-state/` (legacy CLI) and VS Code's `workspaceStorage/*/GitHub.copilot-chat/transcripts/`. The VS Code format has no explicit token counts; tokens are estimated from content length.

**Claude with multiple config directories.** If you run Claude Code under more than one account (`~/.claude-work` and `~/.claude-personal`), point `CLAUDE_CONFIG_DIRS` at all of them: `CLAUDE_CONFIG_DIRS=~/.claude-work:~/.claude-personal devspend`. Sessions are merged into one row per project.

Adding a new provider is a single file. See `src/providers/codex.ts` for an example.

## Features

### Directory Breakdown (devspend dirs)

The feature that motivated this fork. Shows exactly which project directories consumed the most tokens and cost:

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

Options:
- `--period today/week/30days/month/all` — time window (default: 30 days)
- `--provider <name>` — filter to one tool
- `--sort cost/tokens/sessions` — sort order (default: cost)
- `--top N` — show only top N directories
- `--format json` — machine-readable output

### Cost Tracking

Prices every API call using input, output, cache read, cache write, and web search token counts. Fast mode multiplier for Claude. Pricing fetched from [LiteLLM](https://github.com/BerriAI/litellm) and cached locally for 24 hours at `~/.cache/devspend/`.

### Task Categories

13 categories classified from tool usage patterns and user message keywords. No LLM calls, fully deterministic.

| Category | What triggers it |
|---|---|
| Coding | Edit, Write tools |
| Debugging | Error/fix keywords + tool usage |
| Feature Dev | "add", "create", "implement" keywords |
| Refactoring | "refactor", "rename", "simplify" |
| Testing | pytest, vitest, jest in Bash |
| Exploration | Read, Grep, WebSearch without edits |
| Planning | EnterPlanMode, TaskCreate tools |
| Delegation | Agent tool spawns |
| Git Ops | git push/commit/merge in Bash |
| Build/Deploy | npm build, docker, pm2 |
| Brainstorming | "brainstorm", "what if", "design" |
| Conversation | No tools, pure text exchange |
| General | Skill tool, uncategorized |

### Optimize

```bash
devspend optimize                       # scan the last 30 days
devspend optimize -p today              # today only
devspend optimize -p week               # last 7 days
devspend optimize --provider claude     # restrict to one provider
```

Scans sessions and your `~/.claude/` setup for waste patterns:

- Files Claude re-reads across sessions (same content, same context, over and over)
- Low Read:Edit ratio (editing without reading leads to retries)
- Wasted bash output (uncapped `BASH_MAX_OUTPUT_LENGTH`)
- Unused MCP servers paying their tool-schema overhead every session
- Ghost agents, skills, and slash commands never invoked
- Bloated `CLAUDE.md` files (with `@-import` expansion counted)
- Context-heavy sessions where cache tokens swamp output
- Low-worth expensive sessions with no edit turns or repeated retries

Each finding includes the estimated savings and a ready-to-paste fix. Findings roll up into an A–F setup health grade.

### Compare

```bash
devspend compare                        # interactive model picker
devspend compare -p week                # last 7 days
devspend compare --provider claude      # Claude Code sessions only
```

Side-by-side comparison of two models across one-shot rate, retry rate, self-correction, cost per call, cost per edit, cache hit rate, and per-category performance.

### Yield

```bash
devspend yield                  # last 7 days
devspend yield -p 30days        # last 30 days
```

Correlates AI sessions with git commits by timestamp to classify spend as Productive (landed in main), Reverted, or Abandoned. Requires a git repository.

### Plans

```bash
devspend plan set claude-max                                    # $200/month
devspend plan set claude-pro                                    # $20/month
devspend plan set cursor-pro                                    # $20/month
devspend plan set custom --monthly-usd 200 --provider codex    # custom
devspend plan reset --provider codex                           # remove one plan
devspend plan                                                   # show active plans
devspend plan reset                                             # remove all
```

Subscription tracking for Claude Pro, Claude Max, Cursor Pro, and custom provider plans. Plans are stored per provider so you can track Claude and Cursor at the same time.

### Currency

```bash
devspend currency GBP          # British Pounds
devspend currency AUD          # Australian Dollars
devspend currency              # show current setting
devspend currency --reset      # back to USD
```

162 currencies via [ISO 4217](https://en.wikipedia.org/wiki/ISO_4217#List_of_ISO_4217_currency_codes). Exchange rates from [Frankfurter](https://www.frankfurter.app/) (ECB data, no API key). Config stored at `~/.config/devspend/config.json`.

### Model Aliases

If you see `$0.00` for some models, the name reported by your provider doesn't match LiteLLM pricing data (common with proxies).

```bash
devspend model-alias "my-proxy-model" "claude-opus-4-6"   # add alias
devspend model-alias --list                                # show aliases
devspend model-alias --remove "my-proxy-model"             # remove alias
```

### Filtering

```bash
devspend report --project myapp                  # show only projects matching "myapp"
devspend report --exclude myapp                  # exclude a project
devspend month --project api --project web       # include multiple projects
devspend dirs --provider claude                  # Claude-only directory breakdown
devspend report --from 2026-04-01 --to 2026-04-10   # exact date window
```

The `--project` and `--exclude` flags work on all commands and combine with `--provider`.

### JSON Output

```bash
devspend report --format json
devspend status --format json
devspend dirs --format json
devspend export -f json
```

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `DEVSPEND_CACHE_DIR` | Override cache directory (default: `~/.cache/devspend`) |
| `DEVSPEND_VERBOSE` | Print parse warnings to stderr |
| `DEVSPEND_TZ` | IANA timezone for date grouping (e.g. `Asia/Tokyo`) |
| `CLAUDE_CONFIG_DIRS` | Colon-separated list of extra Claude config dirs |

## Upstream

DevSpend is a fork of [CodeBurn](https://github.com/getagentseal/codeburn) (MIT). The upstream remote is kept as a reference for cherry-picking new provider files and pricing data. Brand strings, config paths, and env vars intentionally diverge from upstream.

## License

MIT — Copyright (c) 2026 Bharath Bhaktha
