import { writeFile, mkdir, readdir, open, stat, rm } from 'fs/promises'
import { dirname, join, resolve } from 'path'
import { createRequire } from 'node:module'

const _requireSqlite = createRequire(import.meta.url)

import { CATEGORY_LABELS, type ProjectSummary, type TaskCategory } from './types.js'
import { getCurrency, convertCost, roundForActiveCurrency } from './currency.js'
import { dateKey } from './day-aggregator.js'
import { aggregateModelEfficiency } from './model-efficiency.js'

function escCsv(s: string): string {
  const sanitized = /^[\t\r=+\-@]/.test(s) ? `'${s}` : s
  if (sanitized.includes(',') || sanitized.includes('"') || sanitized.includes('\n')) {
    return `"${sanitized.replace(/"/g, '""')}"`
  }
  return sanitized
}

type Row = Record<string, string | number>

function rowsToCsv(rows: Row[]): string {
  if (rows.length === 0) return ''
  const headers = Object.keys(rows[0])
  const lines = [headers.map(escCsv).join(',')]
  for (const row of rows) {
    lines.push(headers.map(h => escCsv(String(row[h] ?? ''))).join(','))
  }
  return lines.join('\n') + '\n'
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function pct(n: number, total: number): number {
  return total > 0 ? round2((n / total) * 100) : 0
}

type DailyAgg = {
  cost: number
  calls: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  sessions: Set<string>
}

function buildDailyRows(projects: ProjectSummary[], period: string): Row[] {
  const daily: Record<string, DailyAgg> = {}
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const turn of session.turns) {
        if (!turn.timestamp) continue
        const day = dateKey(turn.timestamp)
        if (!daily[day]) {
          daily[day] = { cost: 0, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, sessions: new Set() }
        }
        daily[day].sessions.add(session.sessionId)
        for (const call of turn.assistantCalls) {
          daily[day].cost += call.costUSD
          daily[day].calls++
          daily[day].input += call.usage.inputTokens
          daily[day].output += call.usage.outputTokens
          daily[day].cacheRead += call.usage.cacheReadInputTokens
          daily[day].cacheWrite += call.usage.cacheCreationInputTokens
        }
      }
    }
  }
  const { code } = getCurrency()
  return Object.entries(daily).sort().map(([date, d]) => ({
    Period: period,
    Date: date,
    [`Cost (${code})`]: roundForActiveCurrency(convertCost(d.cost)),
    'API Calls': d.calls,
    Sessions: d.sessions.size,
    'Input Tokens': d.input,
    'Output Tokens': d.output,
    'Cache Read Tokens': d.cacheRead,
    'Cache Write Tokens': d.cacheWrite,
  }))
}

function buildActivityRows(projects: ProjectSummary[], period: string): Row[] {
  const catTotals: Record<string, { turns: number; cost: number }> = {}
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const [cat, d] of Object.entries(session.categoryBreakdown)) {
        if (!catTotals[cat]) catTotals[cat] = { turns: 0, cost: 0 }
        catTotals[cat].turns += d.turns
        catTotals[cat].cost += d.costUSD
      }
    }
  }
  const totalCost = Object.values(catTotals).reduce((s, d) => s + d.cost, 0)
  const { code } = getCurrency()
  return Object.entries(catTotals)
    .sort(([, a], [, b]) => b.cost - a.cost)
    .map(([cat, d]) => ({
      Period: period,
      Activity: CATEGORY_LABELS[cat as TaskCategory] ?? cat,
      [`Cost (${code})`]: roundForActiveCurrency(convertCost(d.cost)),
      'Share (%)': pct(d.cost, totalCost),
      Turns: d.turns,
    }))
}

function buildModelRows(projects: ProjectSummary[], period: string): Row[] {
  const modelTotals: Record<string, { calls: number; cost: number; input: number; output: number; cacheRead: number; cacheWrite: number }> = {}
  const modelEfficiency = aggregateModelEfficiency(projects)
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const [model, d] of Object.entries(session.modelBreakdown)) {
        if (!modelTotals[model]) modelTotals[model] = { calls: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        modelTotals[model].calls += d.calls
        modelTotals[model].cost += d.costUSD
        modelTotals[model].input += d.tokens.inputTokens
        modelTotals[model].output += d.tokens.outputTokens
        modelTotals[model].cacheRead += d.tokens.cacheReadInputTokens ?? 0
        modelTotals[model].cacheWrite += d.tokens.cacheCreationInputTokens ?? 0
      }
    }
  }
  const totalCost = Object.values(modelTotals).reduce((s, d) => s + d.cost, 0)
  const { code } = getCurrency()
  return Object.entries(modelTotals)
    .filter(([name]) => name !== '<synthetic>')
    .sort(([, a], [, b]) => b.cost - a.cost)
    .map(([model, d]) => {
      const efficiency = modelEfficiency.get(model)
      return {
        Period: period,
        Model: model,
        [`Cost (${code})`]: roundForActiveCurrency(convertCost(d.cost)),
        'Share (%)': pct(d.cost, totalCost),
        'API Calls': d.calls,
        'Edit Turns': efficiency?.editTurns ?? 0,
        'One-shot Rate (%)': efficiency?.oneShotRate ?? '',
        'Retries/Edit': efficiency?.retriesPerEdit ?? '',
        [`Cost/Edit (${code})`]: efficiency?.costPerEditUSD !== null && efficiency?.costPerEditUSD !== undefined
          ? roundForActiveCurrency(convertCost(efficiency.costPerEditUSD))
          : '',
        'Input Tokens': d.input,
        'Output Tokens': d.output,
        'Cache Read Tokens': d.cacheRead,
        'Cache Write Tokens': d.cacheWrite,
      }
    })
}

function buildToolRows(projects: ProjectSummary[]): Row[] {
  const toolTotals: Record<string, number> = {}
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const [tool, d] of Object.entries(session.toolBreakdown)) {
        toolTotals[tool] = (toolTotals[tool] ?? 0) + d.calls
      }
    }
  }
  const total = Object.values(toolTotals).reduce((s, n) => s + n, 0)
  return Object.entries(toolTotals)
    .sort(([, a], [, b]) => b - a)
    .map(([tool, calls]) => ({
      Tool: tool,
      Calls: calls,
      'Share (%)': pct(calls, total),
    }))
}

function buildBashRows(projects: ProjectSummary[]): Row[] {
  const bashTotals: Record<string, number> = {}
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const [cmd, d] of Object.entries(session.bashBreakdown)) {
        bashTotals[cmd] = (bashTotals[cmd] ?? 0) + d.calls
      }
    }
  }
  const total = Object.values(bashTotals).reduce((s, n) => s + n, 0)
  return Object.entries(bashTotals)
    .sort(([, a], [, b]) => b - a)
    .map(([cmd, calls]) => ({
      Command: cmd,
      Calls: calls,
      'Share (%)': pct(calls, total),
    }))
}

function buildProjectRows(projects: ProjectSummary[]): Row[] {
  const { code } = getCurrency()
  const total = projects.reduce((s, p) => s + p.totalCostUSD, 0)
  return projects
    .slice()
    .sort((a, b) => b.totalCostUSD - a.totalCostUSD)
    .map(p => ({
      Project: p.projectPath,
      [`Cost (${code})`]: roundForActiveCurrency(convertCost(p.totalCostUSD)),
      [`Avg/Session (${code})`]: p.sessions.length > 0 ? roundForActiveCurrency(convertCost(p.totalCostUSD / p.sessions.length)) : '',
      'Share (%)': pct(p.totalCostUSD, total),
      'API Calls': p.totalApiCalls,
      Sessions: p.sessions.length,
    }))
}

function buildSessionRows(projects: ProjectSummary[]): Row[] {
  const { code } = getCurrency()
  const rows: Row[] = []
  for (const p of projects) {
    for (const s of p.sessions) {
      rows.push({
        Project: p.projectPath,
        'Session ID': s.sessionId,
        'Started At': s.firstTimestamp ?? '',
        [`Cost (${code})`]: roundForActiveCurrency(convertCost(s.totalCostUSD)),
        'API Calls': s.apiCalls,
        Turns: s.turns.length,
      })
    }
  }
  return rows.sort((a, b) => (b[`Cost (${code})`] as number) - (a[`Cost (${code})`] as number))
}

export type PeriodExport = {
  label: string
  projects: ProjectSummary[]
}

function escMd(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function rowsToMarkdownTable(rows: Row[]): string {
  if (rows.length === 0) return '_No data available._\n'
  const headers = Object.keys(rows[0])
  const lines = [
    `| ${headers.map(escMd).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
  ]
  for (const row of rows) {
    lines.push(`| ${headers.map(h => escMd(String(row[h] ?? ''))).join(' | ')} |`)
  }
  return lines.join('\n') + '\n'
}

function rowsToHtmlTable(rows: Row[]): string {
  if (rows.length === 0) return '<p>No data available.</p>'
  const headers = Object.keys(rows[0])
  const head = `<tr>${headers.map(h => `<th>${escHtml(h)}</th>`).join('')}</tr>`
  const body = rows.map(row => `<tr>${headers.map(h => `<td>${escHtml(String(row[h] ?? ''))}</td>`).join('')}</tr>`).join('')
  return `<table><thead>${head}</thead><tbody>${body}</tbody></table>`
}

function buildSummaryRows(periods: PeriodExport[]): Row[] {
  const { code } = getCurrency()
  return periods.map(p => {
    const cost = p.projects.reduce((s, proj) => s + proj.totalCostUSD, 0)
    const calls = p.projects.reduce((s, proj) => s + proj.totalApiCalls, 0)
    const sessions = p.projects.reduce((s, proj) => s + proj.sessions.length, 0)
    const projectCount = p.projects.filter(proj => proj.totalCostUSD > 0).length
    return {
      Period: p.label,
      [`Cost (${code})`]: roundForActiveCurrency(convertCost(cost)),
      'API Calls': calls,
      Sessions: sessions,
      Projects: projectCount,
    }
  })
}

function buildMarkdownDocument(periods: PeriodExport[]): string {
  const { code } = getCurrency()
  const generated = new Date().toISOString()
  const sections = [
    `# DevSpend Usage Export`,
    '',
    `- Generated: ${generated}`,
    `- Currency: ${code}`,
    `- Periods: ${periods.map(p => p.label).join(', ')}`,
    '',
    '## Summary',
    rowsToMarkdownTable(buildSummaryRows(periods)),
    '## Daily',
    rowsToMarkdownTable(periods.flatMap(p => buildDailyRows(p.projects, p.label))),
    '## Activity',
    rowsToMarkdownTable(periods.flatMap(p => buildActivityRows(p.projects, p.label))),
    '## Models',
    rowsToMarkdownTable(periods.flatMap(p => buildModelRows(p.projects, p.label))),
  ]
  return sections.join('\n')
}

function buildHtmlDocument(periods: PeriodExport[]): string {
  const { code } = getCurrency()
  const generated = new Date().toISOString()
  const sections = [
    '<!doctype html>',
    '<html><head><meta charset="utf-8"><title>DevSpend Usage Export</title>',
    '<style>body{font-family:system-ui,sans-serif;max-width:1100px;margin:2rem auto;padding:0 1rem;color:#111}table{border-collapse:collapse;width:100%;margin:1rem 0 2rem}th,td{border:1px solid #ddd;padding:.45rem .6rem;text-align:left;vertical-align:top}th{background:#f5f5f5}</style>',
    '</head><body>',
    '<h1>DevSpend Usage Export</h1>',
    `<p>Generated: ${escHtml(generated)}<br>Currency: ${escHtml(code)}<br>Periods: ${escHtml(periods.map(p => p.label).join(', '))}</p>`,
    '<h2>Summary</h2>',
    rowsToHtmlTable(buildSummaryRows(periods)),
    '<h2>Daily</h2>',
    rowsToHtmlTable(periods.flatMap(p => buildDailyRows(p.projects, p.label))),
    '<h2>Activity</h2>',
    rowsToHtmlTable(periods.flatMap(p => buildActivityRows(p.projects, p.label))),
    '<h2>Models</h2>',
    rowsToHtmlTable(periods.flatMap(p => buildModelRows(p.projects, p.label))),
    '</body></html>',
  ]
  return sections.join('')
}

function buildReadme(periods: PeriodExport[]): string {
  const { code } = getCurrency()
  const generated = new Date().toISOString()
  const lines = [
    'DevSpend Usage Export',
    '====================',
    '',
    `Generated: ${generated}`,
    `Currency:  ${code}`,
    `Periods:   ${periods.map(p => p.label).join(', ')}`,
    '',
    'Files',
    '-----',
    '  summary.csv           One row per period. Headline totals.',
    '  daily.csv             Day-by-day breakdown, Period column distinguishes the window.',
    '  activity.csv          Time spent per task category (Coding, Debugging, Exploration, etc.).',
    '  models.csv            Spend per model with token totals and cache usage.',
    '  projects.csv          Spend per project folder for the selected detail period.',
    '  sessions.csv          One row per session for the selected detail period.',
    '  tools.csv             Tool invocations and share for the selected detail period.',
    '  shell-commands.csv    Shell commands executed via Bash tool for the selected detail period.',
    '',
    'Notes',
    '-----',
    '  Every cost column is already converted to the active currency. Tokens are raw integer',
    '  counts from provider telemetry. Share (%) is relative to the period/table total.',
    '',
  ]
  return lines.join('\n')
}

/// Sentinel file dropped into every folder we create so we can safely overwrite an older
/// codeburn export without ever deleting a user's unrelated files by accident.
const EXPORT_MARKER_FILE = '.devspend-export'

async function isCodeburnExportFolder(path: string): Promise<boolean> {
  const markerStat = await stat(join(path, EXPORT_MARKER_FILE)).catch(() => null)
  return markerStat?.isFile() ?? false
}

async function clearCodeburnExportFolder(path: string): Promise<void> {
  const entries = await readdir(path)
  for (const entry of entries) {
    await rm(join(path, entry), { recursive: true, force: true })
  }
}

/// Writes a folder of one-table-per-file CSVs. The outputPath is treated as a directory. If it
/// ends in `.csv` the extension is stripped to form the folder name. Refuses to delete a
/// pre-existing file or a non-codeburn folder, so a typo like `-o ~/.ssh/id_ed25519` can't
/// wipe a sensitive file (prior versions did `rm(path, { force: true })` unconditionally).
export async function exportCsv(periods: PeriodExport[], outputPath: string): Promise<string> {
  const thirtyDays = periods.find(p => p.label === '30 Days')
  const thirtyDayProjects = thirtyDays?.projects ?? periods[periods.length - 1]?.projects ?? []

  let folder = resolve(outputPath)
  if (folder.toLowerCase().endsWith('.csv')) {
    folder = folder.slice(0, -4)
  }

  const existingStat = await stat(folder).catch(() => null)
  if (existingStat?.isFile()) {
    throw new Error(`Refusing to overwrite existing file at ${folder}. Pass a directory path instead.`)
  }
  if (existingStat?.isDirectory()) {
    if (!(await isCodeburnExportFolder(folder))) {
      throw new Error(
        `Refusing to reuse non-empty directory ${folder}: no ${EXPORT_MARKER_FILE} marker. ` +
        `Delete it manually or pick a different -o path.`
      )
    }
    await clearCodeburnExportFolder(folder)
  }
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, EXPORT_MARKER_FILE), '', 'utf-8')

  const dailyRows = periods.flatMap(p => buildDailyRows(p.projects, p.label))
  const activityRows = periods.flatMap(p => buildActivityRows(p.projects, p.label))
  const modelRows = periods.flatMap(p => buildModelRows(p.projects, p.label))

  await writeFile(join(folder, 'README.txt'), buildReadme(periods), 'utf-8')
  await writeFile(join(folder, 'summary.csv'), rowsToCsv(buildSummaryRows(periods)), 'utf-8')
  await writeFile(join(folder, 'daily.csv'), rowsToCsv(dailyRows), 'utf-8')
  await writeFile(join(folder, 'activity.csv'), rowsToCsv(activityRows), 'utf-8')
  await writeFile(join(folder, 'models.csv'), rowsToCsv(modelRows), 'utf-8')
  await writeFile(join(folder, 'projects.csv'), rowsToCsv(buildProjectRows(thirtyDayProjects)), 'utf-8')
  await writeFile(join(folder, 'sessions.csv'), rowsToCsv(buildSessionRows(thirtyDayProjects)), 'utf-8')
  await writeFile(join(folder, 'tools.csv'), rowsToCsv(buildToolRows(thirtyDayProjects)), 'utf-8')
  await writeFile(join(folder, 'shell-commands.csv'), rowsToCsv(buildBashRows(thirtyDayProjects)), 'utf-8')

  return folder
}

export async function exportJson(periods: PeriodExport[], outputPath: string): Promise<string> {
  const thirtyDays = periods.find(p => p.label === '30 Days')
  const thirtyDayProjects = thirtyDays?.projects ?? periods[periods.length - 1]?.projects ?? []
  const { code, rate, symbol } = getCurrency()

  const data = {
    schema: 'devspend.export.v2',
    generated: new Date().toISOString(),
    currency: { code, rate, symbol },
    summary: buildSummaryRows(periods),
    periods: periods.map(p => ({
      label: p.label,
      daily: buildDailyRows(p.projects, p.label),
      activity: buildActivityRows(p.projects, p.label),
      models: buildModelRows(p.projects, p.label),
    })),
    projects: buildProjectRows(thirtyDayProjects),
    sessions: buildSessionRows(thirtyDayProjects),
    tools: buildToolRows(thirtyDayProjects),
    shellCommands: buildBashRows(thirtyDayProjects),
  }

  const target = resolve(outputPath.toLowerCase().endsWith('.json') ? outputPath : `${outputPath}.json`)
  // Refuse to overwrite an existing file that wasn't produced by codeburn
  // export. CSV path has the same guard via the .codeburn-export marker; JSON
  // was missing it, so a stray `-o ~/important.json` would silently clobber.
  const existing = await stat(target).catch(() => null)
  if (existing?.isFile()) {
    // Read just the first 4KB to look for the schema marker. The schema key
    // is the first field in the JSON object so a partial read is enough;
    // loading the whole file (potentially gigabytes) into memory could OOM
    // on Node's ~512MB string limit.
    const fh = await open(target, 'r')
    try {
      const buf = Buffer.alloc(4096)
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
      const head = buf.toString('utf-8', 0, bytesRead)
      if (!head.includes('"schema": "devspend.export.v')) {
        throw new Error(
          `Refusing to overwrite ${target}: file does not look like a devspend export. ` +
          `Delete it manually or pick a different -o path.`
        )
      }
    } finally {
      await fh.close()
    }
  }
  if (existing?.isDirectory()) {
    throw new Error(`Refusing to overwrite directory at ${target}. Pass a file path instead.`)
  }
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, JSON.stringify(data, null, 2), 'utf-8')
  return target
}

export async function exportMarkdown(periods: PeriodExport[], outputPath: string): Promise<string> {
  const target = resolve(outputPath.toLowerCase().endsWith('.md') ? outputPath : `${outputPath}.md`)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, buildMarkdownDocument(periods), 'utf-8')
  return target
}

export async function exportHtml(periods: PeriodExport[], outputPath: string): Promise<string> {
  const target = resolve(outputPath.toLowerCase().endsWith('.html') ? outputPath : `${outputPath}.html`)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, buildHtmlDocument(periods), 'utf-8')
  return target
}

export async function exportSqlite(periods: PeriodExport[], outputPath: string): Promise<string> {
  type WriteDb = {
    prepare(sql: string): { run(...params: unknown[]): unknown; get(...params: unknown[]): Record<string, unknown> | undefined }
    exec(sql: string): void
    close(): void
  }
  const { DatabaseSync } = _requireSqlite('node:sqlite') as { DatabaseSync: new (path: string) => WriteDb }

  const target = resolve(outputPath.toLowerCase().endsWith('.sqlite') ? outputPath : `${outputPath}.sqlite`)

  const existing = await stat(target).catch(() => null)
  if (existing?.isFile()) {
    let isOurs = false
    try {
      type ReadDb = { prepare(sql: string): { get(...p: unknown[]): Record<string, unknown> | undefined }; close(): void }
      const { DatabaseSync: RDb } = _requireSqlite('node:sqlite') as { DatabaseSync: new (p: string, o?: { readOnly: boolean }) => ReadDb }
      const rdb = new RDb(target, { readOnly: true })
      const row = rdb.prepare('SELECT value FROM meta WHERE key = ?').get('schema') as { value?: string } | undefined
      rdb.close()
      isOurs = typeof row?.value === 'string' && row.value.startsWith('devspend.export.')
    } catch { /* not a valid SQLite file */ }
    if (!isOurs) {
      throw new Error(`Refusing to overwrite ${target}: file does not look like a devspend export. Delete it manually or pick a different -o path.`)
    }
    await rm(target)
  }
  if (existing?.isDirectory()) {
    throw new Error(`Refusing to overwrite directory at ${target}. Pass a file path instead.`)
  }

  await mkdir(dirname(target), { recursive: true })
  const db = new DatabaseSync(target)

  db.exec(`
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY, project TEXT, project_path TEXT,
      first_timestamp TEXT, last_timestamp TEXT, total_cost_usd REAL,
      api_calls INTEGER, turn_count INTEGER, period TEXT
    );
    CREATE TABLE turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT,
      timestamp TEXT, category TEXT, retries INTEGER, has_edits INTEGER,
      cost_usd REAL, input_tokens INTEGER, output_tokens INTEGER,
      cache_read_tokens INTEGER, cache_write_tokens INTEGER
    );
    CREATE TABLE daily_summary (
      date TEXT, period TEXT, cost_usd REAL, api_calls INTEGER, sessions INTEGER,
      input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
      cache_write_tokens INTEGER, PRIMARY KEY (date, period)
    );
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  `)

  db.prepare("INSERT INTO meta VALUES ('schema', 'devspend.export.v1')").run()
  db.prepare("INSERT INTO meta VALUES ('generated', ?)").run(new Date().toISOString())

  const iSess = db.prepare(
    'INSERT OR REPLACE INTO sessions (session_id,project,project_path,first_timestamp,last_timestamp,total_cost_usd,api_calls,turn_count,period) VALUES (?,?,?,?,?,?,?,?,?)'
  )
  const iTurn = db.prepare(
    'INSERT INTO turns (session_id,timestamp,category,retries,has_edits,cost_usd,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens) VALUES (?,?,?,?,?,?,?,?,?,?)'
  )
  const iDay = db.prepare(
    'INSERT OR REPLACE INTO daily_summary (date,period,cost_usd,api_calls,sessions,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens) VALUES (?,?,?,?,?,?,?,?,?)'
  )

  for (const { label: period, projects } of periods) {
    const dailyMap: Record<string, { cost: number; calls: number; sessions: Set<string>; inp: number; out: number; cr: number; cw: number }> = {}

    for (const project of projects) {
      for (const session of project.sessions) {
        iSess.run(
          session.sessionId, project.project, project.projectPath ?? null,
          session.firstTimestamp, session.lastTimestamp, session.totalCostUSD,
          session.apiCalls, session.turns.length, period
        )
        for (const turn of session.turns) {
          const cost = turn.assistantCalls.reduce((s, c) => s + c.costUSD, 0)
          const inp  = turn.assistantCalls.reduce((s, c) => s + c.usage.inputTokens, 0)
          const out  = turn.assistantCalls.reduce((s, c) => s + c.usage.outputTokens, 0)
          const cr   = turn.assistantCalls.reduce((s, c) => s + c.usage.cacheReadInputTokens, 0)
          const cw   = turn.assistantCalls.reduce((s, c) => s + c.usage.cacheCreationInputTokens, 0)
          iTurn.run(session.sessionId, turn.timestamp ?? null, turn.category, turn.retries, turn.hasEdits ? 1 : 0, cost, inp, out, cr, cw)
          const ts = turn.timestamp || turn.assistantCalls[0]?.timestamp
          if (ts) {
            const day = dateKey(ts)
            if (!dailyMap[day]) dailyMap[day] = { cost: 0, calls: 0, sessions: new Set(), inp: 0, out: 0, cr: 0, cw: 0 }
            dailyMap[day].sessions.add(session.sessionId)
            dailyMap[day].cost += cost
            dailyMap[day].calls += turn.assistantCalls.length
            dailyMap[day].inp += inp
            dailyMap[day].out += out
            dailyMap[day].cr += cr
            dailyMap[day].cw += cw
          }
        }
      }
    }

    for (const [date, d] of Object.entries(dailyMap)) {
      iDay.run(date, period, d.cost, d.calls, d.sessions.size, d.inp, d.out, d.cr, d.cw)
    }
  }

  db.close()
  return target
}
