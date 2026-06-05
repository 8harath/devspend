import { Command } from 'commander'
import { installMenubarApp } from './menubar-installer.js'
import { exportCsv, exportHtml, exportJson, exportMarkdown, exportSqlite, type PeriodExport } from './export.js'
import { loadPricing, setModelAliases } from './models.js'
import { parseAllSessions, filterProjectsByName, filterProjectsByDateRange, clearSessionCache } from './parser.js'
import { convertCost } from './currency.js'
import { renderStatusBar, formatTokens, formatCost } from './format.js'
import { type PeriodData, type ProviderCost } from './menubar-json.js'
import { buildMenubarPayload } from './menubar-json.js'
import { getDaysInRange, ensureCacheHydrated, emptyCache, BACKFILL_DAYS, toDateString } from './daily-cache.js'
import { aggregateProjectsIntoDays, buildPeriodDataFromDays, computeSpendTrends, dateKey } from './day-aggregator.js'
import { CATEGORY_LABELS, type DateRange, type ProjectSummary, type TaskCategory } from './types.js'
import { aggregateModelEfficiency } from './model-efficiency.js'
import { renderDashboard, shortProject } from './dashboard.js'
import { formatDateRangeLabel, parseDateRangeFlags, getDateRange, toPeriod, type Period } from './cli-date.js'
import { runOptimize, scanAndDetect } from './optimize.js'
import { renderCompare } from './compare.js'
import { getAllProviders } from './providers/index.js'
import { clearPlan, readConfig, readPlan, readPlans, saveConfig, savePlan, getConfigFilePath, type Plan, type PlanId, type PlanProvider } from './config.js'
import { runGit } from './yield.js'
import { clampResetDay, getPlanUsageOrNull, getPlanUsages, type PlanUsage } from './plan-usage.js'
import { getPresetPlan, isPlanId, isPlanProvider, PLAN_IDS, PLAN_PROVIDERS, planDisplayName } from './plans.js'
import { createRequire } from 'node:module'
import { join, normalize } from 'node:path'

const require = createRequire(import.meta.url)
const { version } = require('../package.json')
import { loadCurrency, getCurrency, isValidCurrencyCode } from './currency.js'

async function hydrateCache() {
  try {
    return await ensureCacheHydrated(
      (range) => parseAllSessions(range, 'all'),
      aggregateProjectsIntoDays,
    )
  } catch {
    return emptyCache()
  }
}

function collect(val: string, acc: string[]): string[] {
  acc.push(val)
  return acc
}

function parseNumber(value: string): number {
  return Number(value)
}

function parseInteger(value: string): number {
  return parseInt(value, 10)
}

async function buildExportPeriods(opts: {
  from?: string
  to?: string
  provider: string
  project: string[]
  exclude: string[]
}) {
  const fp = (p: ProjectSummary[]) => filterProjectsByName(p, opts.project, opts.exclude)
  let customRange: DateRange | null = null
  try {
    customRange = parseDateRangeFlags(opts.from, opts.to)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`\n  Error: ${message}\n`)
    process.exit(1)
  }

  let periods: PeriodExport[]
  if (customRange) {
    periods = [{ label: formatDateRangeLabel(opts.from, opts.to), projects: fp(await parseAllSessions(customRange, opts.provider)) }]
    clearSessionCache()
  } else {
    const thirtyDayProjects = fp(await parseAllSessions(getDateRange('30days').range, opts.provider))
    clearSessionCache()
    periods = [
      { label: 'Today', projects: filterProjectsByDateRange(thirtyDayProjects, getDateRange('today').range) },
      { label: '7 Days', projects: filterProjectsByDateRange(thirtyDayProjects, getDateRange('week').range) },
      { label: '30 Days', projects: thirtyDayProjects },
    ]
  }
  return { periods, customRange }
}

type JsonPlanSummary = {
  id: PlanId
  provider: PlanProvider
  budget: number
  spent: number
  percentUsed: number
  status: 'under' | 'near' | 'over'
  projectedMonthEnd: number
  daysUntilReset: number
  periodStart: string
  periodEnd: string
}

function toJsonPlanSummary(planUsage: PlanUsage): JsonPlanSummary {
  return {
    id: planUsage.plan.id,
    provider: planUsage.plan.provider,
    budget: convertCost(planUsage.budgetUsd),
    spent: convertCost(planUsage.spentApiEquivalentUsd),
    percentUsed: Math.round(planUsage.percentUsed * 10) / 10,
    status: planUsage.status,
    projectedMonthEnd: convertCost(planUsage.projectedMonthUsd),
    daysUntilReset: planUsage.daysUntilReset,
    periodStart: planUsage.periodStart.toISOString(),
    periodEnd: planUsage.periodEnd.toISOString(),
  }
}

type JsonPlanSummaryMap = Partial<Record<PlanProvider, JsonPlanSummary>>

type BudgetScope = 'project' | 'model' | 'directory'
type BudgetTarget = { scope: BudgetScope; key: string; label: string }
type BudgetStatusRow = {
  target: BudgetTarget
  budgetUsd: number
  spentUsd: number
  status: 'OK' | 'NEAR' | 'OVER'
}

function budgetKey(scope: BudgetScope, value: string): string {
  return `${scope}:${value}`
}

function parseBudgetKey(key: string): BudgetTarget {
  const idx = key.indexOf(':')
  if (idx === -1) return { scope: 'project', key, label: key }
  const scope = key.slice(0, idx)
  const value = key.slice(idx + 1)
  if (scope === 'model' || scope === 'directory') return { scope, key: value, label: value }
  if (scope === 'project') return { scope: 'project', key: value, label: value }
  return { scope: 'project', key, label: key }
}

function normalizeDirKey(value: string): string {
  return normalize(value).replace(/\\/g, '/').replace(/\/+$/, '')
}

function projectPathMatches(projectPath: string, dir: string): boolean {
  const normalizedPath = normalize(projectPath).replace(/\\/g, '/')
  const normalizedDir = normalizeDirKey(dir)
  return normalizedDir.length > 0 && (normalizedPath === normalizedDir || normalizedPath.startsWith(`${normalizedDir}/`))
}

export function summarizeBudgets(projects: ProjectSummary[], budgets: Record<string, { monthlyUsd: number; setAt: string }>): BudgetStatusRow[] {
  const modelCosts = new Map<string, number>()
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const [model, data] of Object.entries(session.modelBreakdown)) {
        modelCosts.set(model, (modelCosts.get(model) ?? 0) + data.costUSD)
      }
    }
  }

  const rows: BudgetStatusRow[] = []
  for (const [key, budget] of Object.entries(budgets)) {
    const target = parseBudgetKey(key)
    let spentUsd = 0
    if (target.scope === 'project') {
      const match = projects.find(p => p.project === target.key || (p.projectPath && p.projectPath.includes(target.key)))
      spentUsd = match?.totalCostUSD ?? 0
    } else if (target.scope === 'model') {
      spentUsd = modelCosts.get(target.key) ?? 0
    } else {
      spentUsd = projects.filter(p => projectPathMatches(p.projectPath, target.key)).reduce((sum, project) => sum + project.totalCostUSD, 0)
    }
    const status = spentUsd > budget.monthlyUsd ? 'OVER' : spentUsd > budget.monthlyUsd * 0.8 ? 'NEAR' : 'OK'
    rows.push({ target, budgetUsd: budget.monthlyUsd, spentUsd, status })
  }
  return rows.sort((a, b) => a.target.label.localeCompare(b.target.label))
}

function toJsonPlanSummaryMap(planUsages: PlanUsage[]): JsonPlanSummaryMap {
  const summaries: JsonPlanSummaryMap = {}
  for (const usage of planUsages) {
    summaries[usage.plan.provider] = toJsonPlanSummary(usage)
  }
  return summaries
}

async function attachPlanSummaries<T extends object>(payload: T): Promise<T & { plan?: JsonPlanSummary; plans?: JsonPlanSummaryMap }> {
  const planUsages = await getPlanUsages()
  if (planUsages.length > 0) {
    return {
      ...payload,
      plan: toJsonPlanSummary(planUsages[0]!),
      plans: toJsonPlanSummaryMap(planUsages),
    }
  }
  return payload
}

function planLabel(plan: Plan): string {
  const name = planDisplayName(plan.id)
  return plan.id === 'custom' ? `${name} (${plan.provider})` : name
}

function toPlanDisplay(plan: Plan) {
  return {
    id: plan.id,
    monthlyUsd: plan.monthlyUsd,
    provider: plan.provider,
    resetDay: clampResetDay(plan.resetDay),
    setAt: plan.setAt || null,
  }
}

function sortedPlans(plans: Partial<Record<PlanProvider, Plan>>): Plan[] {
  return PLAN_PROVIDERS
    .map(provider => plans[provider])
    .filter((plan): plan is Plan => plan !== undefined)
}

function assertFormat(value: string, allowed: readonly string[], command: string): void {
  if (!allowed.includes(value)) {
    process.stderr.write(
      `devspend ${command}: unknown format "${value}". Valid values: ${allowed.join(', ')}.\n`
    )
    process.exit(1)
  }
}

async function runJsonReport(period: Period, provider: string, project: string[], exclude: string[]): Promise<void> {
  await loadPricing()
  const { range, label } = getDateRange(period)
  const projects = filterProjectsByName(await parseAllSessions(range, provider), project, exclude)
  const report: ReturnType<typeof buildJsonReport> & { plan?: JsonPlanSummary; plans?: JsonPlanSummaryMap } = await attachPlanSummaries(buildJsonReport(projects, label, period))
  console.log(JSON.stringify(report, null, 2))
}

const program = new Command()
  .name('devspend')
  .description('See where your AI coding tokens go - by task, tool, model, and project')
  .version(version)
  .option('--verbose', 'print warnings to stderr on read failures and skipped files')
  .option('--timezone <zone>', 'IANA timezone for date grouping (e.g. Asia/Tokyo, America/New_York)')

program.hook('preAction', async (thisCommand) => {
  const tz = thisCommand.opts<{ timezone?: string }>().timezone ?? process.env['DEVSPEND_TZ']
  if (tz) {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: tz })
    } catch {
      console.error(`\n  Invalid timezone: "${tz}". Use an IANA timezone like "America/New_York" or "Asia/Tokyo".\n`)
      process.exit(1)
    }
    process.env.TZ = tz
  }
  const config = await readConfig()
  setModelAliases(config.modelAliases ?? {})
  if (thisCommand.opts<{ verbose?: boolean }>().verbose) {
    process.env['DEVSPEND_VERBOSE'] = '1'
  }
  await loadCurrency()
})

function buildJsonReport(projects: ProjectSummary[], period: string, periodKey: string) {
  const sessions = projects.flatMap(p => p.sessions)
  const { code } = getCurrency()

  const totalCostUSD = projects.reduce((s, p) => s + p.totalCostUSD, 0)
  const totalCalls = projects.reduce((s, p) => s + p.totalApiCalls, 0)
  const totalSessions = projects.reduce((s, p) => s + p.sessions.length, 0)
  const totalInput = sessions.reduce((s, sess) => s + sess.totalInputTokens, 0)
  const totalOutput = sessions.reduce((s, sess) => s + sess.totalOutputTokens, 0)
  const totalCacheRead = sessions.reduce((s, sess) => s + sess.totalCacheReadTokens, 0)
  const totalCacheWrite = sessions.reduce((s, sess) => s + sess.totalCacheWriteTokens, 0)
  // Match src/menubar-json.ts:cacheHitPercent: reads over reads+fresh-input. cache_write
  // counts tokens being stored, not served, so it doesn't belong in the denominator.
  const cacheHitDenom = totalInput + totalCacheRead
  const cacheHitPercent = cacheHitDenom > 0 ? Math.round((totalCacheRead / cacheHitDenom) * 1000) / 10 : 0

  // Per-day rollup. Mirrors parser.ts categoryBreakdown semantics so a
  // consumer summing daily[].editTurns over a period gets the same total as
  // sum(activities[].editTurns) for that period: every turn counts once for
  // `turns`, edit turns count for `editTurns`, edit turns with zero retries
  // count for `oneShotTurns`. Issue #279 — daily-resolution efficiency
  // dashboards need this without re-deriving from activity-level rollups.
  const dailyMap: Record<string, { cost: number; calls: number; turns: number; editTurns: number; oneShotTurns: number }> = {}
  for (const sess of sessions) {
    for (const turn of sess.turns) {
      // Prefer the user-message timestamp on the turn; fall back to the first
      // assistant-call timestamp when the user line is missing (continuation
      // sessions where the JSONL begins mid-conversation). Previously these
      // turns dropped from daily but stayed in activities, breaking the
      // sum(daily[].editTurns) === sum(activities[].editTurns) invariant.
      const ts = turn.timestamp || turn.assistantCalls[0]?.timestamp
      if (!ts) { continue }
      const day = dateKey(ts)
      if (!dailyMap[day]) { dailyMap[day] = { cost: 0, calls: 0, turns: 0, editTurns: 0, oneShotTurns: 0 } }
      dailyMap[day].turns += 1
      if (turn.hasEdits) {
        dailyMap[day].editTurns += 1
        if (turn.retries === 0) dailyMap[day].oneShotTurns += 1
      }
      for (const call of turn.assistantCalls) {
        dailyMap[day].cost += call.costUSD
        dailyMap[day].calls += 1
      }
    }
  }
  const daily = Object.entries(dailyMap).sort().map(([date, d]) => ({
    date,
    cost: convertCost(d.cost),
    calls: d.calls,
    turns: d.turns,
    editTurns: d.editTurns,
    oneShotTurns: d.oneShotTurns,
    // Pre-computed convenience for dashboards that don't want to do the math.
    // null when there are no edit turns (the rate is undefined, not zero —
    // a day where the user only had Q&A turns shouldn't read as 0% one-shot).
    oneShotRate: d.editTurns > 0
      ? Math.round((d.oneShotTurns / d.editTurns) * 1000) / 10
      : null,
  }))

  const projectList = projects.map(p => ({
    name: p.project,
    path: p.projectPath,
    cost: convertCost(p.totalCostUSD),
    avgCostPerSession: p.sessions.length > 0
      ? convertCost(p.totalCostUSD / p.sessions.length)
      : null,
    calls: p.totalApiCalls,
    sessions: p.sessions.length,
  }))

  const modelMap: Record<string, { calls: number; cost: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }> = {}
  const modelEfficiency = aggregateModelEfficiency(projects)
  for (const sess of sessions) {
    for (const [model, d] of Object.entries(sess.modelBreakdown)) {
      if (!modelMap[model]) { modelMap[model] = { calls: 0, cost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }
      modelMap[model].calls += d.calls
      modelMap[model].cost += d.costUSD
      modelMap[model].inputTokens += d.tokens.inputTokens
      modelMap[model].outputTokens += d.tokens.outputTokens
      modelMap[model].cacheReadTokens += d.tokens.cacheReadInputTokens
      modelMap[model].cacheWriteTokens += d.tokens.cacheCreationInputTokens
    }
  }
  const models = Object.entries(modelMap)
    .sort(([, a], [, b]) => b.cost - a.cost)
    .map(([name, { cost, ...rest }]) => {
      const efficiency = modelEfficiency.get(name)
      return {
        name,
        ...rest,
        cost: convertCost(cost),
        editTurns: efficiency?.editTurns ?? 0,
        oneShotTurns: efficiency?.oneShotTurns ?? 0,
        oneShotRate: efficiency?.oneShotRate ?? null,
        retriesPerEdit: efficiency?.retriesPerEdit ?? null,
        costPerEdit: efficiency?.costPerEditUSD !== null && efficiency?.costPerEditUSD !== undefined
          ? convertCost(efficiency.costPerEditUSD)
          : null,
      }
    })

  const catMap: Record<string, { turns: number; cost: number; editTurns: number; oneShotTurns: number }> = {}
  for (const sess of sessions) {
    for (const [cat, d] of Object.entries(sess.categoryBreakdown)) {
      if (!catMap[cat]) { catMap[cat] = { turns: 0, cost: 0, editTurns: 0, oneShotTurns: 0 } }
      catMap[cat].turns += d.turns
      catMap[cat].cost += d.costUSD
      catMap[cat].editTurns += d.editTurns
      catMap[cat].oneShotTurns += d.oneShotTurns
    }
  }
  const activities = Object.entries(catMap)
    .sort(([, a], [, b]) => b.cost - a.cost)
    .map(([cat, d]) => ({
      category: CATEGORY_LABELS[cat as TaskCategory] ?? cat,
      cost: convertCost(d.cost),
      turns: d.turns,
      editTurns: d.editTurns,
      oneShotTurns: d.oneShotTurns,
      oneShotRate: d.editTurns > 0 ? Math.round((d.oneShotTurns / d.editTurns) * 1000) / 10 : null,
    }))

  const toolMap: Record<string, number> = {}
  const mcpMap: Record<string, number> = {}
  const bashMap: Record<string, number> = {}
  for (const sess of sessions) {
    for (const [tool, d] of Object.entries(sess.toolBreakdown)) {
      toolMap[tool] = (toolMap[tool] ?? 0) + d.calls
    }
    for (const [server, d] of Object.entries(sess.mcpBreakdown)) {
      mcpMap[server] = (mcpMap[server] ?? 0) + d.calls
    }
    for (const [cmd, d] of Object.entries(sess.bashBreakdown)) {
      bashMap[cmd] = (bashMap[cmd] ?? 0) + d.calls
    }
  }

  const sortedMap = (m: Record<string, number>) =>
    Object.entries(m).sort(([, a], [, b]) => b - a).map(([name, calls]) => ({ name, calls }))

  const topSessions = projects
    .flatMap(p => p.sessions.map(s => ({ project: p.project, sessionId: s.sessionId, date: s.firstTimestamp ? dateKey(s.firstTimestamp) : null, cost: convertCost(s.totalCostUSD), calls: s.apiCalls })))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 5)

  return {
    generated: new Date().toISOString(),
    currency: code,
    period,
    periodKey,
    overview: {
      cost: convertCost(totalCostUSD),
      calls: totalCalls,
      sessions: totalSessions,
      cacheHitPercent,
      tokens: {
        input: totalInput,
        output: totalOutput,
        cacheRead: totalCacheRead,
        cacheWrite: totalCacheWrite,
      },
    },
    daily,
    projects: projectList,
    models,
    activities,
    tools: sortedMap(toolMap),
    mcpServers: sortedMap(mcpMap),
    shellCommands: sortedMap(bashMap),
    topSessions,
  }
}

program
  .command('report', { isDefault: true })
  .description('Interactive usage dashboard')
  .option('-p, --period <period>', 'Starting period: today, week, 30days, month, all', 'week')
  .option('--from <date>', 'Start date (YYYY-MM-DD). Overrides --period when set')
  .option('--to <date>', 'End date (YYYY-MM-DD). Overrides --period when set')
  .option('--provider <provider>', 'Filter by provider (e.g. claude, gemini, cursor, copilot)', 'all')
  .option('--format <format>', 'Output format: tui, json', 'tui')
  .option('--project <name>', 'Show only projects matching name (repeatable)', collect, [])
  .option('--exclude <name>', 'Exclude projects matching name (repeatable)', collect, [])
  .option('--refresh <seconds>', 'Auto-refresh interval in seconds (0 to disable)', parseInteger, 30)
  .action(async (opts) => {
    assertFormat(opts.format, ['tui', 'json'], 'report')
    let customRange: DateRange | null = null
    try {
      customRange = parseDateRangeFlags(opts.from, opts.to)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`\n  Error: ${message}\n`)
      process.exit(1)
    }

    const period = toPeriod(opts.period)
    if (opts.format === 'json') {
      await loadPricing()
      if (customRange) {
        const label = formatDateRangeLabel(opts.from, opts.to)
        const projects = filterProjectsByName(
          await parseAllSessions(customRange, opts.provider),
          opts.project,
          opts.exclude,
        )
        console.log(JSON.stringify(await attachPlanSummaries(buildJsonReport(projects, label, 'custom')), null, 2))
      } else {
        await runJsonReport(period, opts.provider, opts.project, opts.exclude)
      }
      return
    }
    const customRangeLabel = customRange ? formatDateRangeLabel(opts.from, opts.to) : undefined
    await renderDashboard(period, opts.provider, opts.refresh, opts.project, opts.exclude, customRange, customRangeLabel)
  })

function buildPeriodData(label: string, projects: ProjectSummary[]): PeriodData {
  const sessions = projects.flatMap(p => p.sessions)
  const catTotals: Record<string, { turns: number; cost: number; editTurns: number; oneShotTurns: number }> = {}
  const modelTotals: Record<string, { calls: number; cost: number }> = {}
  let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0

  for (const sess of sessions) {
    inputTokens += sess.totalInputTokens
    outputTokens += sess.totalOutputTokens
    cacheReadTokens += sess.totalCacheReadTokens
    cacheWriteTokens += sess.totalCacheWriteTokens
    for (const [cat, d] of Object.entries(sess.categoryBreakdown)) {
      if (!catTotals[cat]) catTotals[cat] = { turns: 0, cost: 0, editTurns: 0, oneShotTurns: 0 }
      catTotals[cat].turns += d.turns
      catTotals[cat].cost += d.costUSD
      catTotals[cat].editTurns += d.editTurns
      catTotals[cat].oneShotTurns += d.oneShotTurns
    }
    for (const [model, d] of Object.entries(sess.modelBreakdown)) {
      if (!modelTotals[model]) modelTotals[model] = { calls: 0, cost: 0 }
      modelTotals[model].calls += d.calls
      modelTotals[model].cost += d.costUSD
    }
  }

  return {
    label,
    cost: projects.reduce((s, p) => s + p.totalCostUSD, 0),
    calls: projects.reduce((s, p) => s + p.totalApiCalls, 0),
    sessions: projects.reduce((s, p) => s + p.sessions.length, 0),
    inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
    categories: Object.entries(catTotals)
      .sort(([, a], [, b]) => b.cost - a.cost)
      .map(([cat, d]) => ({ name: CATEGORY_LABELS[cat as TaskCategory] ?? cat, ...d })),
    models: Object.entries(modelTotals)
      .sort(([, a], [, b]) => b.cost - a.cost)
      .map(([name, d]) => ({ name, ...d })),
  }
}

program
  .command('status')
  .description('Compact status output (today + month)')
  .option('--format <format>', 'Output format: terminal, menubar-json, json', 'terminal')
  .option('--provider <provider>', 'Filter by provider (e.g. claude, gemini, cursor, copilot)', 'all')
  .option('--project <name>', 'Show only projects matching name (repeatable)', collect, [])
  .option('--exclude <name>', 'Exclude projects matching name (repeatable)', collect, [])
  .option('--period <period>', 'Primary period for menubar-json: today, week, 30days, month, all', 'today')
  .option('--no-optimize', 'Skip optimize findings (menubar-json only, faster)')
  .action(async (opts) => {
    assertFormat(opts.format, ['terminal', 'menubar-json', 'json'], 'status')
    await loadPricing()
    const pf = opts.provider
    const fp = (p: ProjectSummary[]) => filterProjectsByName(p, opts.project, opts.exclude)
    if (opts.format === 'menubar-json') {
      const periodInfo = getDateRange(opts.period)
      const now = new Date()
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      const todayRange: DateRange = { start: todayStart, end: now }
      const todayStr = toDateString(todayStart)
      const yesterdayStr = toDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))
      const rangeStartStr = toDateString(periodInfo.range.start)
      const rangeEndStr = toDateString(periodInfo.range.end)
      const isAllProviders = pf === 'all'

      const cache = await hydrateCache()
      let todayAllProjects: ProjectSummary[] | null = null
      let todayAllDays: ReturnType<typeof aggregateProjectsIntoDays> | null = null

      const getTodayAllProjects = async (): Promise<ProjectSummary[]> => {
        if (!todayAllProjects) {
          todayAllProjects = fp(await parseAllSessions(todayRange, 'all'))
        }
        return todayAllProjects
      }

      const getTodayAllDays = async (): Promise<ReturnType<typeof aggregateProjectsIntoDays>> => {
        if (!todayAllDays) {
          todayAllDays = aggregateProjectsIntoDays(await getTodayAllProjects())
        }
        return todayAllDays
      }

      // CURRENT PERIOD DATA
      // - .all provider: assemble from cache + today (fast)
      // - specific provider: parse the period range with provider filter (correct, but slower)
      let currentData: PeriodData
      let scanProjects: ProjectSummary[]
      let scanRange: DateRange

      if (isAllProviders) {
        // Parse today's all-provider sessions once; historical data comes from cache to avoid
        // double-counting. Reusing the same parsed object is important for the menubar path:
        // large active sessions can OOM if this command retains multiple near-identical scans.
        const todayProjects = await getTodayAllProjects()
        const todayDays = await getTodayAllDays()
        const historicalDays = getDaysInRange(cache, rangeStartStr, yesterdayStr)
        const todayInRange = todayDays.filter(d => d.date >= rangeStartStr && d.date <= rangeEndStr)
        const allDays = [...historicalDays, ...todayInRange].sort((a, b) => a.date.localeCompare(b.date))
        currentData = buildPeriodDataFromDays(allDays, periodInfo.label)
        scanProjects = todayProjects
        scanRange = periodInfo.range
      } else {
        const projects = fp(await parseAllSessions(periodInfo.range, pf))
        currentData = buildPeriodData(periodInfo.label, projects)
        scanProjects = projects
        scanRange = periodInfo.range
      }

      // PROVIDERS
      // For .all: enumerate every provider with cost across the period (from cache) + installed-but-zero.
      // For specific: just this single provider with its scoped cost.
      const allProviders = await getAllProviders()
      const displayNameByName = new Map(allProviders.map(p => [p.name, p.displayName]))
      const providers: ProviderCost[] = []
      if (isAllProviders) {
        const allDaysForProviders = [
          ...getDaysInRange(cache, rangeStartStr, yesterdayStr),
          ...(await getTodayAllDays()).filter(d => d.date === todayStr),
        ]
        const providerTotals: Record<string, number> = {}
        for (const d of allDaysForProviders) {
          for (const [name, p] of Object.entries(d.providers)) {
            providerTotals[name] = (providerTotals[name] ?? 0) + p.cost
          }
        }
        for (const [name, cost] of Object.entries(providerTotals)) {
          providers.push({ name: displayNameByName.get(name) ?? name, cost })
        }
        for (const p of allProviders) {
          if (providers.some(pc => pc.name === p.displayName)) continue
          const sources = await p.discoverSessions()
          if (sources.length > 0) providers.push({ name: p.displayName, cost: 0 })
        }
      } else {
        const display = displayNameByName.get(pf) ?? pf
        providers.push({ name: display, cost: currentData.cost })
      }

      // DAILY HISTORY (last 365 days)
      // Cache stores per-provider cost+calls per day in DailyEntry.providers, so we can derive
      // a provider-filtered history without re-parsing. Tokens aren't broken down per provider
      // in the cache, so the filtered view shows zero tokens (heatmap/trend still works on cost).
      const historyStartStr = toDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() - BACKFILL_DAYS))
      const allCacheDays = getDaysInRange(cache, historyStartStr, yesterdayStr)
      const fullHistory = [...allCacheDays, ...(await getTodayAllDays()).filter(d => d.date === todayStr)]
      const dailyHistory = fullHistory.map(d => {
        if (isAllProviders) {
          const topModels = Object.entries(d.models)
            .filter(([name]) => name !== '<synthetic>')
            .sort(([, a], [, b]) => b.cost - a.cost)
            .slice(0, 5)
            .map(([name, m]) => ({
              name,
              cost: m.cost,
              calls: m.calls,
              inputTokens: m.inputTokens,
              outputTokens: m.outputTokens,
            }))
          return {
            date: d.date,
            cost: d.cost,
            calls: d.calls,
            inputTokens: d.inputTokens,
            outputTokens: d.outputTokens,
            cacheReadTokens: d.cacheReadTokens,
            cacheWriteTokens: d.cacheWriteTokens,
            topModels,
          }
        }
        const prov = d.providers[pf] ?? { calls: 0, cost: 0 }
        return {
          date: d.date,
          cost: prov.cost,
          calls: prov.calls,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          topModels: [],
        }
      })

      const optimize = opts.optimize === false ? null : await scanAndDetect(scanProjects, scanRange)
      console.log(JSON.stringify(buildMenubarPayload(currentData, providers, optimize, dailyHistory)))
      return
    }

    if (opts.format === 'json') {
      const todayProjects = fp(await parseAllSessions(getDateRange('today').range, pf))
      const todayData = buildPeriodData('today', todayProjects)
      clearSessionCache()
      const monthProjects = fp(await parseAllSessions(getDateRange('month').range, pf))
      const monthData = buildPeriodData('month', monthProjects)
      clearSessionCache()
      const { code, rate } = getCurrency()
      const payload: {
        currency: string
        today: { cost: number; calls: number }
        month: { cost: number; calls: number }
        plan?: JsonPlanSummary
        plans?: JsonPlanSummaryMap
      } = {
        currency: code,
        today: { cost: Math.round(todayData.cost * rate * 100) / 100, calls: todayData.calls },
        month: { cost: Math.round(monthData.cost * rate * 100) / 100, calls: monthData.calls },
      }
      console.log(JSON.stringify(await attachPlanSummaries(payload)))
      return
    }

    const monthProjects2 = fp(await parseAllSessions(getDateRange('month').range, pf))
    clearSessionCache()
    console.log(renderStatusBar(monthProjects2))
  })

program
  .command('today')
  .description('Today\'s usage dashboard')
  .option('--provider <provider>', 'Filter by provider (e.g. claude, gemini, cursor, copilot)', 'all')
  .option('--format <format>', 'Output format: tui, json', 'tui')
  .option('--project <name>', 'Show only projects matching name (repeatable)', collect, [])
  .option('--exclude <name>', 'Exclude projects matching name (repeatable)', collect, [])
  .option('--refresh <seconds>', 'Auto-refresh interval in seconds (0 to disable)', parseInteger, 30)
  .action(async (opts) => {
    assertFormat(opts.format, ['tui', 'json'], 'today')
    if (opts.format === 'json') {
      await runJsonReport('today', opts.provider, opts.project, opts.exclude)
      return
    }
    await renderDashboard('today', opts.provider, opts.refresh, opts.project, opts.exclude)
  })

program
  .command('month')
  .description('This month\'s usage dashboard')
  .option('--provider <provider>', 'Filter by provider (e.g. claude, gemini, cursor, copilot)', 'all')
  .option('--format <format>', 'Output format: tui, json', 'tui')
  .option('--project <name>', 'Show only projects matching name (repeatable)', collect, [])
  .option('--exclude <name>', 'Exclude projects matching name (repeatable)', collect, [])
  .option('--refresh <seconds>', 'Auto-refresh interval in seconds (0 to disable)', parseInteger, 30)
  .action(async (opts) => {
    assertFormat(opts.format, ['tui', 'json'], 'month')
    if (opts.format === 'json') {
      await runJsonReport('month', opts.provider, opts.project, opts.exclude)
      return
    }
    await renderDashboard('month', opts.provider, opts.refresh, opts.project, opts.exclude)
  })

program
  .command('export')
  .description('Export usage data to CSV, JSON, SQLite, Markdown, or HTML')
  .option('-f, --format <format>', 'Export format: csv, json, sqlite, markdown, html', 'csv')
  .option('-o, --output <path>', 'Output file path')
  .option('--from <date>', 'Start date (YYYY-MM-DD). Exports a single custom period when set')
  .option('--to <date>', 'End date (YYYY-MM-DD). Exports a single custom period when set')
  .option('--provider <provider>', 'Filter by provider (e.g. claude, gemini, cursor, copilot)', 'all')
  .option('--project <name>', 'Show only projects matching name (repeatable)', collect, [])
  .option('--exclude <name>', 'Exclude projects matching name (repeatable)', collect, [])
  .action(async (opts) => {
    assertFormat(opts.format, ['csv', 'json', 'sqlite', 'markdown', 'html'], 'export')
    await loadPricing()
    const { periods, customRange } = await buildExportPeriods({
      from: opts.from,
      to: opts.to,
      provider: opts.provider,
      project: opts.project,
      exclude: opts.exclude,
    })

    if (periods.every(p => p.projects.length === 0)) {
      console.log('\n  No usage data found.\n')
      return
    }

    const defaultName = `devspend-${toDateString(new Date())}`
    const outputPath = opts.output ?? `${defaultName}.${opts.format === 'markdown' ? 'md' : opts.format}`

    let savedPath: string
    try {
      if (opts.format === 'json') {
        savedPath = await exportJson(periods, outputPath)
      } else if (opts.format === 'sqlite') {
        savedPath = await exportSqlite(periods, outputPath)
      } else if (opts.format === 'markdown') {
        savedPath = await exportMarkdown(periods, outputPath)
      } else if (opts.format === 'html') {
        savedPath = await exportHtml(periods, outputPath)
      } else {
        savedPath = await exportCsv(periods, outputPath)
      }
    } catch (err) {
      // Protection guards in export.ts (symlink refusal, non-codeburn folder refusal, etc.)
      // throw with a user-readable message. Print just the message, not the stack, so the CLI
      // doesn't spray its internals at the user.
      const message = err instanceof Error ? err.message : String(err)
      console.error(`\n  Export failed: ${message}\n`)
      process.exit(1)
    }

    const exportedLabel = customRange ? formatDateRangeLabel(opts.from, opts.to) : 'Today + 7 Days + 30 Days'
    console.log(`\n  Exported (${exportedLabel}) to: ${savedPath}\n`)
  })

program
  .command('export-schedule')
  .description('Schedule recurring exports into a directory with timestamped filenames')
  .option('-f, --format <format>', 'Export format: csv, json, sqlite, markdown, html', 'md')
  .option('-o, --output <path>', 'Output directory path')
  .option('--every <minutes>', 'Run interval in minutes', parseNumber, 60)
  .option('--runs <count>', 'Number of exports to run before exiting (0 = forever)', parseInteger, 0)
  .option('--from <date>', 'Start date (YYYY-MM-DD). Exports a single custom period when set')
  .option('--to <date>', 'End date (YYYY-MM-DD). Exports a single custom period when set')
  .option('--provider <provider>', 'Filter by provider (e.g. claude, gemini, cursor, copilot)', 'all')
  .option('--project <name>', 'Show only projects matching name (repeatable)', collect, [])
  .option('--exclude <name>', 'Exclude projects matching name (repeatable)', collect, [])
  .action(async (opts) => {
    const allowed = ['csv', 'json', 'sqlite', 'markdown', 'md', 'html']
    assertFormat(opts.format, allowed, 'export-schedule')
    await loadPricing()
    const { periods, customRange } = await buildExportPeriods({
      from: opts.from,
      to: opts.to,
      provider: opts.provider,
      project: opts.project,
      exclude: opts.exclude,
    })
    if (periods.every(p => p.projects.length === 0)) {
      console.log('\n  No usage data found.\n')
      return
    }
    const baseDir = opts.output ?? `devspend-export-${toDateString(new Date())}`
    const suffix = opts.format === 'md' ? 'md' : opts.format
    const doOnce = async () => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const outputPath = join(baseDir, `devspend-${stamp}.${suffix}`)
      let savedPath = outputPath
      if (opts.format === 'json') savedPath = await exportJson(periods, outputPath)
      else if (opts.format === 'sqlite') savedPath = await exportSqlite(periods, outputPath)
      else if (opts.format === 'html') savedPath = await exportHtml(periods, outputPath)
      else if (opts.format === 'markdown' || opts.format === 'md') savedPath = await exportMarkdown(periods, outputPath)
      else savedPath = await exportCsv(periods, outputPath)
      console.log(`\n  Exported (${customRange ? formatDateRangeLabel(opts.from, opts.to) : 'Today + 7 Days + 30 Days'}) to: ${savedPath}\n`)
    }
    let runs = 0
    while (opts.runs === 0 || runs < opts.runs) {
      await doOnce()
      runs++
      if (opts.runs !== 0 && runs >= opts.runs) break
      await new Promise(r => setTimeout(r, opts.every * 60_000))
    }
  })

program
  .command('menubar')
  .description('Install and launch the macOS menubar app (one command, no clone)')
  .option('--force', 'Reinstall even if an older copy is already in ~/Applications')
  .action(async (opts: { force?: boolean }) => {
    try {
      const result = await installMenubarApp({ force: opts.force })
      console.log(`\n  Ready. ${result.installedPath}\n`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`\n  Menubar install failed: ${message}\n`)
      process.exit(1)
    }
  })

program
  .command('currency [code]')
  .description('Set display currency (e.g. devspend currency GBP)')
  .option('--symbol <symbol>', 'Override the currency symbol')
  .option('--reset', 'Reset to USD (removes currency config)')
  .action(async (code?: string, opts?: { symbol?: string; reset?: boolean }) => {
    if (opts?.reset) {
      const config = await readConfig()
      delete config.currency
      await saveConfig(config)
      console.log('\n  Currency reset to USD.\n')
      return
    }

    if (!code) {
      const { code: activeCode, rate, symbol } = getCurrency()
      if (activeCode === 'USD' && rate === 1) {
        console.log('\n  Currency: USD (default)')
        console.log(`  Config: ${getConfigFilePath()}\n`)
      } else {
        console.log(`\n  Currency: ${activeCode}`)
        console.log(`  Symbol: ${symbol}`)
        console.log(`  Rate: 1 USD = ${rate} ${activeCode}`)
        console.log(`  Config: ${getConfigFilePath()}\n`)
      }
      return
    }

    const upperCode = code.toUpperCase()
    if (!isValidCurrencyCode(upperCode)) {
      console.error(`\n  "${code}" is not a valid ISO 4217 currency code.\n`)
      process.exitCode = 1
      return
    }

    const config = await readConfig()
    config.currency = {
      code: upperCode,
      ...(opts?.symbol ? { symbol: opts.symbol } : {}),
    }
    await saveConfig(config)

    await loadCurrency()
    const { rate, symbol } = getCurrency()

    console.log(`\n  Currency set to ${upperCode}.`)
    console.log(`  Symbol: ${symbol}`)
    console.log(`  Rate: 1 USD = ${rate} ${upperCode}`)
    console.log(`  Config saved to ${getConfigFilePath()}\n`)
  })

program
  .command('model-alias [from] [to]')
  .description('Map a provider model name to a canonical one for pricing (e.g. devspend model-alias my-model claude-opus-4-6)')
  .option('--remove <from>', 'Remove an alias')
  .option('--list', 'List configured aliases')
  .action(async (from?: string, to?: string, opts?: { remove?: string; list?: boolean }) => {
    const config = await readConfig()
    const aliases = config.modelAliases ?? {}

    if (opts?.list || (!from && !opts?.remove)) {
      const entries = Object.entries(aliases)
      if (entries.length === 0) {
        console.log('\n  No model aliases configured.')
        console.log(`  Config: ${getConfigFilePath()}\n`)
      } else {
        console.log('\n  Model aliases:')
        for (const [src, dst] of entries) {
          console.log(`    ${src} -> ${dst}`)
        }
        console.log(`  Config: ${getConfigFilePath()}\n`)
      }
      return
    }

    if (opts?.remove) {
      if (!(opts.remove in aliases)) {
        console.error(`\n  Alias not found: ${opts.remove}\n`)
        process.exitCode = 1
        return
      }
      delete aliases[opts.remove]
      config.modelAliases = Object.keys(aliases).length > 0 ? aliases : undefined
      await saveConfig(config)
      console.log(`\n  Removed alias: ${opts.remove}\n`)
      return
    }

    if (!from || !to) {
      console.error('\n  Usage: devspend model-alias <from> <to>\n')
      process.exitCode = 1
      return
    }

    aliases[from] = to
    config.modelAliases = aliases
    await saveConfig(config)
    console.log(`\n  Alias saved: ${from} -> ${to}`)
    console.log(`  Config: ${getConfigFilePath()}\n`)
  })

program
  .command('plan [action] [id]')
  .description('Show or configure a subscription plan for overage tracking')
  .option('--format <format>', 'Output format: text or json', 'text')
  .option('--monthly-usd <n>', 'Monthly plan price in USD (for custom)', parseNumber)
  .option('--provider <name>', 'Provider scope: all, claude, codex, cursor')
  .option('--reset-day <n>', 'Day of month plan resets (1-28)', parseInteger, 1)
  .action(async (action?: string, id?: string, opts?: { format?: string; monthlyUsd?: number; provider?: string; resetDay?: number }) => {
    assertFormat(opts?.format ?? 'text', ['text', 'json'], 'plan')
    const mode = action ?? 'show'
    const providerOption = opts?.provider
    if (providerOption !== undefined && !isPlanProvider(providerOption)) {
      console.error(`\n  --provider must be one of: all, claude, codex, cursor; got "${providerOption}".\n`)
      process.exitCode = 1
      return
    }

    if (mode === 'show') {
      const plans = sortedPlans(await readPlans())
        .filter(plan => plan.id !== 'none')
        .filter(plan => !providerOption || providerOption === 'all' || plan.provider === providerOption)
      if (opts?.format === 'json') {
        if (plans.length === 0) {
          console.log(JSON.stringify({ id: 'none', monthlyUsd: 0, provider: 'all', resetDay: 1, setAt: null }))
          return
        }
        console.log(JSON.stringify({
          ...toPlanDisplay(plans[0]!),
          plans: Object.fromEntries(plans.map(plan => [plan.provider, toPlanDisplay(plan)])),
        }))
        return
      }
      if (plans.length === 0) {
        console.log('\n  Plan: none')
        console.log('  API-pricing view is active.')
        console.log(`  Config: ${getConfigFilePath()}\n`)
        return
      }
      console.log(`\n  Plans: ${plans.length}`)
      for (const plan of plans) {
        console.log(`  ${plan.provider}: ${planLabel(plan)} (${plan.id})`)
        console.log(`    Budget: $${plan.monthlyUsd}/month`)
        console.log(`    Reset day: ${clampResetDay(plan.resetDay)}`)
        if (plan.setAt) console.log(`    Set at: ${plan.setAt}`)
      }
      console.log(`  Config: ${getConfigFilePath()}\n`)
      return
    }

    if (mode === 'reset') {
      await clearPlan(providerOption)
      if (providerOption) {
        console.log(`\n  Plan reset for ${providerOption}.\n`)
      } else {
        console.log('\n  Plan reset. API-pricing view is active.\n')
      }
      return
    }

    if (mode !== 'set') {
      console.error('\n  Usage: devspend plan [set <id> | reset]\n')
      process.exitCode = 1
      return
    }

    if (!id || !isPlanId(id)) {
      console.error(`\n  Plan id must be one of: ${PLAN_IDS.join(', ')}; got "${id ?? ''}".\n`)
      process.exitCode = 1
      return
    }

    const resetDay = opts?.resetDay ?? 1
    if (!Number.isInteger(resetDay) || resetDay < 1 || resetDay > 28) {
      console.error(`\n  --reset-day must be an integer from 1 to 28; got ${resetDay}.\n`)
      process.exitCode = 1
      return
    }

    if (id === 'none') {
      await clearPlan(providerOption)
      if (providerOption) {
        console.log(`\n  Plan reset for ${providerOption}.\n`)
      } else {
        console.log('\n  Plan reset. API-pricing view is active.\n')
      }
      return
    }

    if (id === 'custom') {
      if (opts?.monthlyUsd === undefined) {
        console.error('\n  Custom plans require --monthly-usd <positive number>.\n')
        process.exitCode = 1
        return
      }
      const monthlyUsd = opts.monthlyUsd
      if (!Number.isFinite(monthlyUsd) || monthlyUsd <= 0) {
        console.error(`\n  --monthly-usd must be a positive number; got ${opts.monthlyUsd}.\n`)
        process.exitCode = 1
        return
      }
      const provider = providerOption ?? 'all'
      await savePlan({
        id: 'custom',
        monthlyUsd,
        provider,
        resetDay,
        setAt: new Date().toISOString(),
      })
      console.log(`\n  Plan set to custom ($${monthlyUsd}/month, ${provider}, reset day ${resetDay}).`)
      console.log(`  Config saved to ${getConfigFilePath()}\n`)
      return
    }

    const preset = getPresetPlan(id)
    if (!preset) {
      console.error(`\n  Unknown preset "${id}".\n`)
      process.exitCode = 1
      return
    }

    if (providerOption === 'all') {
      console.error(`\n  ${id} is a ${preset.provider} plan; omit --provider or use --provider ${preset.provider}.\n`)
      process.exitCode = 1
      return
    }

    if (providerOption && providerOption !== preset.provider) {
      console.error(`\n  ${id} is a ${preset.provider} plan; use --provider ${preset.provider} or omit --provider.\n`)
      process.exitCode = 1
      return
    }

    await savePlan({
      ...preset,
      resetDay,
      setAt: new Date().toISOString(),
    })
    console.log(`\n  Plan set to ${planDisplayName(preset.id)} ($${preset.monthlyUsd}/month).`)
    console.log(`  Provider: ${preset.provider}`)
    console.log(`  Reset day: ${resetDay}`)
    console.log(`  Config saved to ${getConfigFilePath()}\n`)
  })

program
  .command('optimize')
  .description('Find token waste and get exact fixes')
  .option('-p, --period <period>', 'Analysis period: today, week, 30days, month, all', '30days')
  .option('--provider <provider>', 'Filter by provider (e.g. claude, gemini, cursor, copilot)', 'all')
  .action(async (opts) => {
    await loadPricing()
    const { range, label } = getDateRange(opts.period)
    const projects = await parseAllSessions(range, opts.provider)
    await runOptimize(projects, label, range)
  })

program
  .command('compare')
  .description('Compare two AI models side-by-side')
  .option('-p, --period <period>', 'Analysis period: today, week, 30days, month, all', 'all')
  .option('--provider <provider>', 'Filter by provider (e.g. claude, gemini, cursor, copilot)', 'all')
  .action(async (opts) => {
    await loadPricing()
    const { range } = getDateRange(opts.period)
    await renderCompare(range, opts.provider)
  })

program
  .command('models')
  .description('Per-model token + cost table, optionally exploded by task type')
  .option('-p, --period <period>', 'Analysis period: today, week, 30days, month, all', '30days')
  .option('--from <date>', 'Custom range start (YYYY-MM-DD)')
  .option('--to <date>', 'Custom range end (YYYY-MM-DD)')
  .option('--provider <provider>', 'Filter by provider (e.g. claude, codex, cursor)', 'all')
  .option('--task <category>', 'Filter to one task type (e.g. feature, debugging, refactoring)')
  .option('--by-task', 'One row per (provider, model, task) instead of one row per (provider, model)')
  .option('--top <n>', 'Show only the top N rows', (v: string) => parseInt(v, 10))
  .option('--min-cost <usd>', 'Hide rows below this cost threshold', (v: string) => parseFloat(v))
  .option('--no-totals', 'Suppress the footer totals row')
  .option('--format <format>', 'Output format: table, markdown, json, csv', 'table')
  .action(async (opts) => {
    const { aggregateModels, renderTable, renderMarkdown, renderJson, renderCsv } = await import('./models-report.js')
    await loadPricing()

    let range
    if (opts.from || opts.to) {
      const customRange = parseDateRangeFlags(opts.from, opts.to)
      if (!customRange) {
        process.stderr.write('devspend: --from and --to must be valid YYYY-MM-DD dates\n')
        process.exit(1)
      }
      range = customRange
    } else {
      range = getDateRange(opts.period).range
    }

    const projects = await parseAllSessions(range, opts.provider)
    const rows = await aggregateModels(projects, {
      byTask: !!opts.byTask,
      taskFilter: opts.task,
      topN: typeof opts.top === 'number' && Number.isFinite(opts.top) ? opts.top : undefined,
      minCost: typeof opts.minCost === 'number' && Number.isFinite(opts.minCost) ? opts.minCost : 0.01,
    })

    const fmt = (opts.format ?? 'table').toLowerCase()
    if (rows.length === 0 && (fmt === 'table' || fmt === 'markdown')) {
      process.stdout.write('No model usage found for the selected period.\n')
      return
    }
    if (fmt === 'json') {
      process.stdout.write(renderJson(rows) + '\n')
    } else if (fmt === 'csv') {
      process.stdout.write(renderCsv(rows, { byTask: !!opts.byTask }) + '\n')
    } else if (fmt === 'markdown' || fmt === 'md') {
      process.stdout.write(renderMarkdown(rows, { byTask: !!opts.byTask, showTotals: opts.totals !== false }) + '\n')
    } else if (fmt === 'table') {
      process.stdout.write(renderTable(rows, { byTask: !!opts.byTask, showTotals: opts.totals !== false }) + '\n')
    } else {
      process.stderr.write(`devspend: unknown --format "${opts.format}". Choose table, markdown, json, or csv.\n`)
      process.exit(1)
    }
  })

program
  .command('dirs')
  .description('Token and cost breakdown by project directory')
  .option('-p, --period <period>', 'Analysis period: today, week, 30days, month, all', '30days')
  .option('--provider <provider>', 'Filter by provider (e.g. claude, cursor, copilot)', 'all')
  .option('--sort <by>', 'Sort by: cost, tokens, sessions', 'cost')
  .option('--top <n>', 'Show only the top N directories', (v: string) => parseInt(v, 10))
  .option('--format <format>', 'Output format: table, json', 'table')
  .action(async (opts) => {
    await loadPricing()
    const { range, label } = getDateRange(opts.period)
    const projects = await parseAllSessions(range, opts.provider)

    if (projects.length === 0) {
      console.log('\n  No usage data found for the selected period.\n')
      return
    }

    type DirRow = {
      dir: string
      fullPath: string
      inputTokens: number
      outputTokens: number
      cacheTokens: number
      costUSD: number
      sessions: number
    }

    const rows: DirRow[] = projects.map(p => ({
      dir: shortProject(p.projectPath || p.project),
      fullPath: p.projectPath || p.project,
      inputTokens: p.sessions.reduce((s, sess) => s + sess.totalInputTokens, 0),
      outputTokens: p.sessions.reduce((s, sess) => s + sess.totalOutputTokens, 0),
      cacheTokens: p.sessions.reduce((s, sess) => s + sess.totalCacheReadTokens + sess.totalCacheWriteTokens, 0),
      costUSD: p.totalCostUSD,
      sessions: p.sessions.length,
    }))

    const sortBy = opts.sort ?? 'cost'
    rows.sort((a, b) => {
      if (sortBy === 'tokens') return (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens)
      if (sortBy === 'sessions') return b.sessions - a.sessions
      return b.costUSD - a.costUSD
    })

    const topN = typeof opts.top === 'number' && Number.isFinite(opts.top) ? opts.top : undefined
    const displayRows = topN ? rows.slice(0, topN) : rows

    if (opts.format === 'json') {
      const { code, rate } = getCurrency()
      process.stdout.write(JSON.stringify({
        period: label,
        provider: opts.provider,
        currency: code,
        dirs: displayRows.map(r => ({
          dir: r.dir,
          path: r.fullPath,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          cacheTokens: r.cacheTokens,
          cost: Math.round(r.costUSD * rate * 100) / 100,
          sessions: r.sessions,
        })),
      }, null, 2) + '\n')
      return
    }

    const DIR_W = Math.min(Math.max(...displayRows.map(r => r.dir.length), 9), 42)
    const HDR = [
      'Directory'.padEnd(DIR_W),
      'Input'.padStart(8),
      'Output'.padStart(8),
      'Cache'.padStart(8),
      'Sessions'.padStart(9),
      'Cost'.padStart(9),
    ]
    const sep = '─'.repeat(HDR.join('  ').length)
    const providerLabel = opts.provider === 'all' ? 'all providers' : opts.provider
    process.stdout.write(`\n  Directory Breakdown  ·  ${label}  ·  ${providerLabel}\n\n`)
    process.stdout.write(`  ${HDR.join('  ')}\n`)
    process.stdout.write(`  ${sep}\n`)

    for (const r of displayRows) {
      const cols = [
        r.dir.padEnd(DIR_W),
        formatTokens(r.inputTokens).padStart(8),
        formatTokens(r.outputTokens).padStart(8),
        formatTokens(r.cacheTokens).padStart(8),
        String(r.sessions).padStart(9),
        formatCost(r.costUSD).padStart(9),
      ]
      process.stdout.write(`  ${cols.join('  ')}\n`)
    }

    process.stdout.write(`  ${sep}\n`)
    const tot = {
      inp: rows.reduce((s, r) => s + r.inputTokens, 0),
      out: rows.reduce((s, r) => s + r.outputTokens, 0),
      cch: rows.reduce((s, r) => s + r.cacheTokens, 0),
      cost: rows.reduce((s, r) => s + r.costUSD, 0),
      sess: rows.reduce((s, r) => s + r.sessions, 0),
    }
    const footerLabel = `${rows.length} ${rows.length === 1 ? 'directory' : 'directories'}`
    const footer = [
      footerLabel.padEnd(DIR_W),
      formatTokens(tot.inp).padStart(8),
      formatTokens(tot.out).padStart(8),
      formatTokens(tot.cch).padStart(8),
      String(tot.sess).padStart(9),
      formatCost(tot.cost).padStart(9),
    ]
    process.stdout.write(`  ${footer.join('  ')}\n\n`)
  })

program
  .command('yield')
  .description('Track which AI spend shipped to main vs reverted/abandoned (experimental)')
  .option('-p, --period <period>', 'Analysis period: today, week, 30days, month, all', 'week')
  .action(async (opts) => {
    const { computeYield, formatYieldSummary } = await import('./yield.js')
    await loadPricing()
    const { range, label } = getDateRange(opts.period)
    console.log(`\n  Analyzing yield for ${label}...\n`)
    const summary = await computeYield(range, process.cwd())
    console.log(formatYieldSummary(summary))
  })

program
  .command('burn-rate')
  .description('Show daily spend rate, trend, and projected monthly cost')
  .option('-p, --period <period>', 'Analysis period: week, 30days, month, all', 'week')
  .option('--provider <provider>', 'Filter by provider', 'all')
  .action(async (opts) => {
    await loadPricing()
    const { range, label } = getDateRange(opts.period)
    const projects = await parseAllSessions(range, opts.provider)

    const dailyCosts: Record<string, number> = {}
    for (const project of projects) {
      for (const session of project.sessions) {
        for (const turn of session.turns) {
          const ts = turn.timestamp || turn.assistantCalls[0]?.timestamp
          if (!ts) continue
          const day = dateKey(ts)
          for (const call of turn.assistantCalls) {
            dailyCosts[day] = (dailyCosts[day] ?? 0) + call.costUSD
          }
        }
      }
    }

    const days = Object.keys(dailyCosts).sort()
    if (days.length === 0) {
      console.log('\n  No usage data found for this period.\n')
      return
    }

    const total = Object.values(dailyCosts).reduce((s, c) => s + c, 0)
    const avg = total / days.length
    const half = Math.floor(days.length / 2)
    const firstHalfAvg = half > 0
      ? days.slice(0, half).reduce((s, d) => s + (dailyCosts[d] ?? 0), 0) / half
      : avg
    const secondHalfAvg = days.length - half > 0
      ? days.slice(half).reduce((s, d) => s + (dailyCosts[d] ?? 0), 0) / (days.length - half)
      : avg
    const trend = secondHalfAvg > firstHalfAvg * 1.05 ? '↑ increasing' : secondHalfAvg < firstHalfAvg * 0.95 ? '↓ decreasing' : '→ stable'
    const maxDaily = Math.max(...Object.values(dailyCosts))
    const BAR_W = 24
    const trends = computeSpendTrends(projects)

    console.log(`\n  Burn Rate  ·  ${label}\n`)
    console.log(`  ${'Average daily'.padEnd(22)}${formatCost(avg)}`)
    console.log(`  ${'Trend'.padEnd(22)}${trend}`)
    console.log(`  ${'WoW delta'.padEnd(22)}${formatCost(trends.week.deltaCost)}${trends.week.deltaPercent === null ? '' : ` (${trends.week.deltaPercent >= 0 ? '+' : ''}${trends.week.deltaPercent.toFixed(1)}%)`}`)
    console.log(`  ${'MoM delta'.padEnd(22)}${formatCost(trends.month.deltaCost)}${trends.month.deltaPercent === null ? '' : ` (${trends.month.deltaPercent >= 0 ? '+' : ''}${trends.month.deltaPercent.toFixed(1)}%)`}`)
    console.log(`  ${'Projected 30 days'.padEnd(22)}${formatCost(avg * 30)}`)
    console.log(`  ${'Total for period'.padEnd(22)}${formatCost(total)}`)
    console.log(`  ${'Active days'.padEnd(22)}${days.length}`)
    console.log()
    console.log(`  ${'Date'.padEnd(6)}  ${''.padEnd(BAR_W)}  Cost`)
    console.log(`  ${'─'.repeat(6 + 2 + BAR_W + 2 + 8)}`)
    for (const day of days) {
      const cost = dailyCosts[day] ?? 0
      const filled = maxDaily > 0 ? Math.round((cost / maxDaily) * BAR_W) : 0
      const bar = '▓'.repeat(filled) + '░'.repeat(BAR_W - filled)
      console.log(`  ${day.slice(5)}  ${bar}  ${formatCost(cost)}`)
    }
    console.log()
  })

program
  .command('digest')
  .description('Generate a shareable text or markdown summary of your AI spend')
  .option('-p, --period <period>', 'Analysis period: today, week, 30days, month', 'week')
  .option('--provider <provider>', 'Filter by provider', 'all')
  .option('--format <format>', 'Output format: text, markdown', 'text')
  .action(async (opts) => {
    assertFormat(opts.format, ['text', 'markdown'], 'digest')
    await loadPricing()
    const { range, label } = getDateRange(opts.period)
    const projects = filterProjectsByName(await parseAllSessions(range, opts.provider), [], [])

    const allSessions = projects.flatMap(p => p.sessions)
    const totalCost = projects.reduce((s, p) => s + p.totalCostUSD, 0)
    const totalCalls = projects.reduce((s, p) => s + p.totalApiCalls, 0)
    const totalSessions = allSessions.length
    const totalCacheRead = allSessions.reduce((s, sess) => s + sess.totalCacheReadTokens, 0)
    const totalInput = allSessions.reduce((s, sess) => s + sess.totalInputTokens, 0)
    const cacheHit = totalInput + totalCacheRead > 0 ? (totalCacheRead / (totalInput + totalCacheRead)) * 100 : 0

    const md = opts.format === 'markdown'
    const h2 = (t: string) => md ? `\n## ${t}\n` : `\n  ${t.toUpperCase()}\n  ${'─'.repeat(t.length)}`
    const li = (k: string, v: string) => md ? `- **${k}:** ${v}` : `  ${k.padEnd(22)}${v}`

    if (md) {
      console.log(`# DevSpend: ${label}\n`)
    } else {
      console.log(`\n  DevSpend digest  ·  ${label}`)
    }

    console.log(h2('Overview'))
    console.log(li('Total cost', formatCost(totalCost)))
    console.log(li('API calls', totalCalls.toLocaleString()))
    console.log(li('Sessions', String(totalSessions)))
    console.log(li('Cache hit rate', `${cacheHit.toFixed(1)}%`))

    if (projects.length > 0) {
      console.log(h2('Top Projects'))
      for (const p of projects.slice(0, 5)) {
        console.log(li(shortProject(p.projectPath), `${formatCost(p.totalCostUSD)}  (${p.sessions.length} sessions)`))
      }
    }

    const modelMap: Record<string, number> = {}
    for (const sess of allSessions) {
      for (const [model, d] of Object.entries(sess.modelBreakdown)) {
        modelMap[model] = (modelMap[model] ?? 0) + d.costUSD
      }
    }
    const topModels = Object.entries(modelMap).sort(([, a], [, b]) => b - a).slice(0, 4)
    if (topModels.length > 0) {
      console.log(h2('Top Models'))
      for (const [model, cost] of topModels) {
        console.log(li(model, formatCost(cost)))
      }
    }

    const catMap: Record<string, number> = {}
    for (const sess of allSessions) {
      for (const [cat, d] of Object.entries(sess.categoryBreakdown)) {
        catMap[cat] = (catMap[cat] ?? 0) + d.costUSD
      }
    }
    const topCats = Object.entries(catMap).sort(([, a], [, b]) => b - a).slice(0, 6)
    if (topCats.length > 0) {
      console.log(h2('By Activity'))
      for (const [cat, cost] of topCats) {
        console.log(li(CATEGORY_LABELS[cat as TaskCategory] ?? cat, formatCost(cost)))
      }
    }
    console.log()
  })

program
  .command('top')
  .description('Show the most expensive sessions or days')
  .option('-n, --count <n>', 'Number of items to show', '10')
  .option('--by <metric>', 'Rank by: sessions, days', 'sessions')
  .option('-p, --period <period>', 'Analysis period: today, week, 30days, month, all', 'all')
  .option('--provider <provider>', 'Filter by provider', 'all')
  .action(async (opts) => {
    await loadPricing()
    const { range, label } = getDateRange(opts.period)
    const projects = await parseAllSessions(range, opts.provider)
    const n = Math.max(1, parseInt(opts.count, 10) || 10)

    console.log()

    if (opts.by === 'days') {
      const dailyCosts: Record<string, number> = {}
      for (const project of projects) {
        for (const session of project.sessions) {
          for (const turn of session.turns) {
            const ts = turn.timestamp || turn.assistantCalls[0]?.timestamp
            if (!ts) continue
            const day = dateKey(ts)
            for (const call of turn.assistantCalls) {
              dailyCosts[day] = (dailyCosts[day] ?? 0) + call.costUSD
            }
          }
        }
      }
      const sorted = Object.entries(dailyCosts).sort(([, a], [, b]) => b - a).slice(0, n)
      if (sorted.length === 0) { console.log('  No data found.\n'); return }
      console.log(`  Top ${n} days  ·  ${label}\n`)
      console.log(`  ${'Date'.padEnd(12)}${'Cost'.padStart(10)}`)
      console.log(`  ${'─'.repeat(22)}`)
      for (const [day, cost] of sorted) {
        console.log(`  ${day.padEnd(12)}${formatCost(cost).padStart(10)}`)
      }
    } else {
      const allSessions = projects
        .flatMap(p => p.sessions.map(s => ({ ...s, projectPath: p.projectPath })))
        .sort((a, b) => b.totalCostUSD - a.totalCostUSD)
        .slice(0, n)
      if (allSessions.length === 0) { console.log('  No sessions found.\n'); return }
      console.log(`  Top ${n} sessions  ·  ${label}\n`)
      console.log(`  ${'Date'.padEnd(11)}${'Project'.padEnd(30)}${'Cost'.padStart(10)}${'Calls'.padStart(7)}`)
      console.log(`  ${'─'.repeat(58)}`)
      for (const s of allSessions) {
        const date = s.firstTimestamp ? s.firstTimestamp.slice(0, 10) : '----------'
        const proj = shortProject(s.projectPath).slice(0, 28)
        console.log(`  ${date.padEnd(11)}${proj.padEnd(30)}${formatCost(s.totalCostUSD).padStart(10)}${String(s.apiCalls).padStart(7)}`)
      }
    }
    console.log()
  })

program
  .command('ci')
  .description('Exit 1 if AI spend exceeds configured thresholds (for CI pipelines)')
  .option('--max-cost <usd>', 'Max allowed cost in USD', parseFloat)
  .option('--max-tokens <n>', 'Max allowed total tokens', parseInteger)
  .option('-p, --period <period>', 'Period to check: today, week, 30days', 'today')
  .option('--provider <provider>', 'Filter by provider', 'all')
  .option('--format <format>', 'Output format: text, json', 'text')
  .action(async (opts) => {
    assertFormat(opts.format, ['text', 'json'], 'ci')
    await loadPricing()
    const { range, label } = getDateRange(opts.period)
    const projects = await parseAllSessions(range, opts.provider)
    const sessions = projects.flatMap(p => p.sessions)
    const totalCost = projects.reduce((s, p) => s + p.totalCostUSD, 0)
    const totalCalls = projects.reduce((s, p) => s + p.totalApiCalls, 0)
    const totalTokens = sessions.reduce((s, sess) =>
      s + sess.totalInputTokens + sess.totalOutputTokens + sess.totalCacheReadTokens + sess.totalCacheWriteTokens, 0)

    const breaches: string[] = []
    if (opts.maxCost !== undefined && totalCost > opts.maxCost) {
      breaches.push(`cost ${formatCost(totalCost)} exceeds limit ${formatCost(opts.maxCost)}`)
    }
    if (opts.maxTokens !== undefined && totalTokens > opts.maxTokens) {
      breaches.push(`tokens ${totalTokens.toLocaleString()} exceeds limit ${opts.maxTokens.toLocaleString()}`)
    }

    const passed = breaches.length === 0
    if (opts.format === 'json') {
      console.log(JSON.stringify({
        passed, period: label, cost: totalCost, calls: totalCalls, tokens: totalTokens,
        maxCost: opts.maxCost ?? null, maxTokens: opts.maxTokens ?? null, breaches,
      }, null, 2))
    } else {
      console.log(`\n  CI Gate  ·  ${label}`)
      console.log(`  ${'Cost'.padEnd(22)}${formatCost(totalCost)}${opts.maxCost !== undefined ? `  (limit: ${formatCost(opts.maxCost)})` : ''}`)
      console.log(`  ${'Tokens'.padEnd(22)}${formatTokens(totalTokens)}${opts.maxTokens !== undefined ? `  (limit: ${formatTokens(opts.maxTokens)})` : ''}`)
      console.log(`  ${'Status'.padEnd(22)}${passed ? 'PASS' : 'FAIL'}`)
      if (!passed) { console.log(); for (const b of breaches) console.error(`  ${b}`) }
      console.log()
    }
    if (!passed) process.exit(1)
  })

program
  .command('alert [action]')
  .description('Manage daily/weekly spend alert thresholds and budget warnings')
  .option('--daily <usd>', 'Daily spend threshold in USD', parseFloat)
  .option('--weekly <usd>', 'Weekly spend threshold in USD', parseFloat)
  .option('--webhook <url>', 'Webhook URL to POST when a threshold is breached')
  .action(async (action?: string, opts?: { daily?: number; weekly?: number; webhook?: string }) => {
    const mode = action ?? 'show'

    if (mode === 'set') {
      if (opts?.daily === undefined && opts?.weekly === undefined) {
        console.error('\n  Provide at least --daily or --weekly.\n')
        process.exitCode = 1; return
      }
      const config = await readConfig()
      config.alerts = {
        ...(config.alerts ?? {}),
        ...(opts?.daily !== undefined ? { dailyUsd: opts.daily } : {}),
        ...(opts?.weekly !== undefined ? { weeklyUsd: opts.weekly } : {}),
        ...(opts?.webhook !== undefined ? { webhook: opts.webhook } : {}),
      }
      await saveConfig(config)
      console.log('\n  Alert thresholds saved:')
      if (config.alerts.dailyUsd) console.log(`  Daily:  $${config.alerts.dailyUsd}`)
      if (config.alerts.weeklyUsd) console.log(`  Weekly: $${config.alerts.weeklyUsd}`)
      if (config.alerts.webhook) console.log(`  Webhook: ${config.alerts.webhook}`)
      console.log(`  Config: ${getConfigFilePath()}\n`)
      return
    }

    if (mode === 'clear') {
      const config = await readConfig()
      delete config.alerts
      await saveConfig(config)
      console.log('\n  Alert thresholds cleared.\n')
      return
    }

    if (mode === 'check') {
      await loadPricing()
      const config = await readConfig()
      const alerts = config.alerts ?? {}
      if (!alerts.dailyUsd && !alerts.weeklyUsd && Object.keys(config.budgets ?? {}).length === 0) {
        console.log('\n  No alert thresholds set. Use: devspend alert set --daily <usd>\n')
        return
      }
      const budgetRows = summarizeBudgets(await parseAllSessions(getDateRange('month').range, 'all'), config.budgets ?? {})
      const breaches: string[] = []
      console.log()
      if (alerts.dailyUsd) {
        const todayProjects = await parseAllSessions(getDateRange('today').range, 'all')
        const todayCost = todayProjects.reduce((s, p) => s + p.totalCostUSD, 0)
        clearSessionCache()
        if (todayCost > alerts.dailyUsd) {
          breaches.push(`Daily spend ${formatCost(todayCost)} exceeds limit ${formatCost(alerts.dailyUsd)}`)
        } else {
          console.log(`  Daily:  ${formatCost(todayCost)} / $${alerts.dailyUsd} — OK`)
        }
      }
      if (alerts.weeklyUsd) {
        const weekProjects = await parseAllSessions(getDateRange('week').range, 'all')
        const weekCost = weekProjects.reduce((s, p) => s + p.totalCostUSD, 0)
        if (weekCost > alerts.weeklyUsd) {
          breaches.push(`Weekly spend ${formatCost(weekCost)} exceeds limit ${formatCost(alerts.weeklyUsd)}`)
        } else {
          console.log(`  Weekly: ${formatCost(weekCost)} / $${alerts.weeklyUsd} — OK`)
        }
      }
      for (const row of budgetRows) {
        if (row.status === 'OVER') {
          breaches.push(`${row.target.scope} budget ${row.target.label} exceeds limit ${formatCost(row.budgetUsd)} (${formatCost(row.spentUsd)})`)
        } else {
          const scopeLabel = row.target.scope[0].toUpperCase() + row.target.scope.slice(1)
          console.log(`  ${scopeLabel}: ${row.target.label} ${formatCost(row.spentUsd)} / ${formatCost(row.budgetUsd)} — ${row.status}`)
        }
      }
      if (breaches.length > 0) {
        console.log()
        for (const breach of breaches) console.error(`  ALERT: ${breach}`)
        if (alerts.webhook) {
          try {
            await fetch(alerts.webhook, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ breaches, timestamp: new Date().toISOString() }),
            })
          } catch { /* webhook failure is non-fatal */ }
        }
        process.exitCode = 1
      } else {
        console.log('  All thresholds OK.')
      }
      console.log()
      return
    }

    const config = await readConfig()
    const alerts = config.alerts ?? {}
    if (!alerts.dailyUsd && !alerts.weeklyUsd && Object.keys(config.budgets ?? {}).length === 0) {
      console.log('\n  No alert thresholds configured.')
      console.log('  Use: devspend alert set --daily <usd>\n')
      return
    }
    console.log('\n  Alert thresholds:')
    if (alerts.dailyUsd) console.log(`  Daily:  $${alerts.dailyUsd}`)
    if (alerts.weeklyUsd) console.log(`  Weekly: $${alerts.weeklyUsd}`)
    if (alerts.webhook) console.log(`  Webhook: ${alerts.webhook}`)
    for (const [key, budget] of Object.entries(config.budgets ?? {})) {
      const target = parseBudgetKey(key)
      console.log(`  Budget: ${target.scope} ${target.label} -> $${budget.monthlyUsd}`)
    }
    console.log(`  Config: ${getConfigFilePath()}\n`)
  })

program
  .command('since <ref>')
  .description('Show AI spend since a git ref, commit, or tag')
  .option('--provider <provider>', 'Filter by provider', 'all')
  .option('--format <format>', 'Output format: text, json', 'text')
  .action(async (ref: string, opts) => {
    assertFormat(opts.format, ['text', 'json'], 'since')
    if (!ref.trim() || /[\0\n\r\t ]/.test(ref)) {
      console.error('\n  Invalid git ref.\n'); process.exit(1)
    }
    const refTime = runGit(['log', '-1', '--format=%aI', ref], process.cwd())
    if (!refTime) {
      console.error(`\n  Could not resolve git ref "${ref}". Are you in a git repository with that ref?\n`)
      process.exit(1)
    }
    await loadPricing()
    const start = new Date(refTime)
    const range: DateRange = { start, end: new Date() }
    const projects = await parseAllSessions(range, opts.provider)
    const sessions = projects.flatMap(p => p.sessions)
    const totalCost = projects.reduce((s, p) => s + p.totalCostUSD, 0)
    const totalCalls = projects.reduce((s, p) => s + p.totalApiCalls, 0)
    const totalInput = sessions.reduce((s, sess) => s + sess.totalInputTokens, 0)
    const totalOutput = sessions.reduce((s, sess) => s + sess.totalOutputTokens, 0)
    const label = `since ${ref}  (${start.toISOString().slice(0, 16).replace('T', ' ')} UTC)`
    if (opts.format === 'json') {
      console.log(JSON.stringify({
        ref, since: refTime, cost: totalCost, calls: totalCalls,
        sessions: sessions.length, inputTokens: totalInput, outputTokens: totalOutput,
        projects: projects.map(p => ({ name: p.project, cost: p.totalCostUSD })),
      }, null, 2))
      return
    }
    console.log(`\n  ${label}\n`)
    console.log(`  ${'Total cost'.padEnd(22)}${formatCost(totalCost)}`)
    console.log(`  ${'API calls'.padEnd(22)}${totalCalls.toLocaleString()}`)
    console.log(`  ${'Sessions'.padEnd(22)}${sessions.length}`)
    console.log(`  ${'Input tokens'.padEnd(22)}${formatTokens(totalInput)}`)
    console.log(`  ${'Output tokens'.padEnd(22)}${formatTokens(totalOutput)}`)
    if (projects.length > 0) {
      console.log()
      for (const p of projects.slice(0, 10)) {
        console.log(`  ${shortProject(p.projectPath || p.project).slice(0, 28).padEnd(30)}${formatCost(p.totalCostUSD)}`)
      }
    }
    console.log()
  })

program
  .command('tasks')
  .description('Ranked list of task categories by cost')
  .option('-p, --period <period>', 'Analysis period: today, week, 30days, month, all', 'week')
  .option('--provider <provider>', 'Filter by provider', 'all')
  .option('--top <n>', 'Show top N task categories', (v: string) => parseInt(v, 10))
  .option('--format <format>', 'Output format: text, json', 'text')
  .action(async (opts) => {
    assertFormat(opts.format, ['text', 'json'], 'tasks')
    await loadPricing()
    const { range, label } = getDateRange(opts.period)
    const projects = await parseAllSessions(range, opts.provider)

    const catMap: Record<string, { cost: number; turns: number; editTurns: number; oneShotTurns: number }> = {}
    for (const project of projects) {
      for (const session of project.sessions) {
        for (const [cat, d] of Object.entries(session.categoryBreakdown)) {
          if (!catMap[cat]) catMap[cat] = { cost: 0, turns: 0, editTurns: 0, oneShotTurns: 0 }
          catMap[cat].cost += d.costUSD
          catMap[cat].turns += d.turns
          catMap[cat].editTurns += d.editTurns
          catMap[cat].oneShotTurns += d.oneShotTurns
        }
      }
    }

    const totalCost = Object.values(catMap).reduce((s, d) => s + d.cost, 0)
    let rows = Object.entries(catMap)
      .sort(([, a], [, b]) => b.cost - a.cost)
      .map(([cat, d]) => ({
        category: CATEGORY_LABELS[cat as TaskCategory] ?? cat,
        cost: d.cost,
        turns: d.turns,
        oneShotRate: d.editTurns > 0 ? Math.round((d.oneShotTurns / d.editTurns) * 100) : null,
        share: totalCost > 0 ? Math.round((d.cost / totalCost) * 100) : 0,
      }))
    if (opts.top) rows = rows.slice(0, opts.top)

    if (opts.format === 'json') {
      console.log(JSON.stringify({ period: label, totalCost, tasks: rows }, null, 2))
      return
    }
    if (rows.length === 0) { console.log('\n  No task data found.\n'); return }

    const CAT_W = Math.min(Math.max(...rows.map(r => r.category.length), 12), 30)
    console.log(`\n  Tasks  ·  ${label}\n`)
    console.log(`  ${'Category'.padEnd(CAT_W)}  ${'Cost'.padStart(10)}  ${'Share'.padStart(6)}  ${'Turns'.padStart(6)}  ${'1-shot%'.padStart(7)}`)
    console.log(`  ${'─'.repeat(CAT_W + 36)}`)
    for (const r of rows) {
      const os = r.oneShotRate !== null ? `${r.oneShotRate}%` : '─'
      console.log(`  ${r.category.padEnd(CAT_W)}  ${formatCost(r.cost).padStart(10)}  ${`${r.share}%`.padStart(6)}  ${String(r.turns).padStart(6)}  ${os.padStart(7)}`)
    }
    console.log()
  })

program
  .command('budget [action] [project] [amount]')
  .description('Manage per-project monthly budget caps')
  .option('--model', 'Treat the target as a model budget')
  .option('--dir', 'Treat the target as a directory budget')
  .action(async (action?: string, project?: string, amount?: string, opts?: { model?: boolean; dir?: boolean }) => {
    const mode = action ?? 'status'
    const scope: BudgetScope = opts?.model ? 'model' : opts?.dir ? 'directory' : 'project'

    if (mode === 'set') {
      if (!project || !amount) {
        const scopeHint = scope === 'project' ? '<project>' : scope === 'model' ? '<model>' : '<directory>'
        console.error(`\n  Usage: devspend budget set ${scopeHint} <amount-usd>\n`)
        process.exitCode = 1; return
      }
      const monthlyUsd = parseFloat(amount)
      if (!Number.isFinite(monthlyUsd) || monthlyUsd <= 0) {
        console.error(`\n  Amount must be a positive number; got "${amount}".\n`)
        process.exitCode = 1; return
      }
      const config = await readConfig()
      config.budgets = config.budgets ?? {}
      config.budgets[budgetKey(scope, scope === 'directory' ? normalizeDirKey(project) : project)] = { monthlyUsd, setAt: new Date().toISOString() }
      await saveConfig(config)
      console.log(`\n  Budget set: ${scope} ${project} → $${monthlyUsd}/month`)
      console.log(`  Config: ${getConfigFilePath()}\n`)
      return
    }

    if (mode === 'clear') {
      const config = await readConfig()
      if (project) {
        if (!config.budgets?.[project]) {
          console.error(`\n  No budget found for "${project}".\n`)
          process.exitCode = 1; return
        }
        delete config.budgets![project]
        if (Object.keys(config.budgets!).length === 0) delete config.budgets
        await saveConfig(config)
        console.log(`\n  Budget cleared for "${project}".\n`)
      } else {
        delete config.budgets
        await saveConfig(config)
        console.log('\n  All budgets cleared.\n')
      }
      return
    }

    const config = await readConfig()
    const budgets = config.budgets ?? {}
    if (Object.keys(budgets).length === 0) {
      console.log('\n  No budgets configured.')
      console.log('  Use: devspend budget set <project> <amount>\n')
      return
    }
    await loadPricing()
    const monthProjects = await parseAllSessions(getDateRange('month').range, 'all')
    const rows = summarizeBudgets(monthProjects, budgets)
    let anyOver = false
    const N = 30
    console.log('\n  Budget Status  ·  this month\n')
    console.log(`  ${'Target'.padEnd(N)}  ${'Budget'.padStart(10)}  ${'Spent'.padStart(10)}  ${'Status'.padStart(8)}`)
    console.log(`  ${'─'.repeat(N + 32)}`)
    for (const row of rows) {
      const spent = row.spentUsd
      const budget = row.budgetUsd
      const status = row.status
      if (status === 'OVER') anyOver = true
      const label = row.target.scope === 'project'
        ? row.target.label
        : `${row.target.scope}:${row.target.label}`
      console.log(`  ${label.slice(0, N - 2).padEnd(N)}  ${formatCost(budget).padStart(10)}  ${formatCost(spent).padStart(10)}  ${status.padStart(8)}`)
    }
    console.log()
    if (anyOver) process.exitCode = 1
  })

program
  .command('watch')
  .description('Live cost ticker — polls the active session every N seconds')
  .option('--interval <seconds>', 'Poll interval in seconds (min 5)', '30')
  .option('--provider <provider>', 'Filter by provider', 'all')
  .action(async (opts) => {
    const interval = Math.max(5, parseInt(opts.interval, 10) || 30) * 1000
    await loadPricing()

    const render = async () => {
      clearSessionCache()
      const now = new Date()
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      const range: DateRange = { start: todayStart, end: now }
      const projects = await parseAllSessions(range, opts.provider)
      const sessions = projects.flatMap(p => p.sessions)
      const totalCost = projects.reduce((s, p) => s + p.totalCostUSD, 0)
      const totalCalls = projects.reduce((s, p) => s + p.totalApiCalls, 0)
      process.stdout.write('\x1b[2J\x1b[0;0H')
      console.log(`  devspend watch  ·  ${now.toLocaleTimeString()}  ·  Ctrl+C to stop`)
      console.log()
      console.log(`  ${'Today cost'.padEnd(22)}${formatCost(totalCost)}`)
      console.log(`  ${'API calls'.padEnd(22)}${totalCalls.toLocaleString()}`)
      console.log(`  ${'Sessions'.padEnd(22)}${sessions.length}`)
      console.log()
      if (projects.length > 0) {
        const W = 30
        console.log(`  ${'Project'.padEnd(W)}  ${'Cost'.padStart(10)}`)
        console.log(`  ${'─'.repeat(W + 12)}`)
        for (const p of projects.slice(0, 10)) {
          console.log(`  ${shortProject(p.projectPath || p.project).slice(0, W - 2).padEnd(W)}  ${formatCost(p.totalCostUSD).padStart(10)}`)
        }
        console.log()
      }
      console.log(`  Next update in ${interval / 1000}s`)
    }

    await render()
    const timer = setInterval(render, interval)
    process.on('SIGINT', () => {
      clearInterval(timer)
      console.log('\n\n  Stopped.\n')
      process.exit(0)
    })
    await new Promise<never>(() => {})
  })

program
  .command('diff')
  .description('Compare AI spend across two time windows')
  .option('-p, --period <period>', 'Period for window A: today, week, 30days, month', 'week')
  .option('--from <date>', 'Window A start (YYYY-MM-DD)')
  .option('--to <date>', 'Window A end (YYYY-MM-DD)')
  .option('--compare-from <date>', 'Window B start (YYYY-MM-DD)')
  .option('--compare-to <date>', 'Window B end (YYYY-MM-DD)')
  .option('--provider <provider>', 'Filter by provider', 'all')
  .option('--format <format>', 'Output format: text, json', 'text')
  .action(async (opts) => {
    assertFormat(opts.format, ['text', 'json'], 'diff')
    await loadPricing()

    let rangeA: DateRange, labelA: string
    if (opts.from || opts.to) {
      const r = parseDateRangeFlags(opts.from, opts.to)
      if (!r) { console.error('\n  Invalid --from/--to dates.\n'); process.exit(1) }
      rangeA = r
      labelA = formatDateRangeLabel(opts.from ?? '', opts.to ?? '')
    } else {
      const d = getDateRange(opts.period)
      rangeA = d.range; labelA = d.label
    }

    let rangeB: DateRange, labelB: string
    if (opts.compareFrom || opts.compareTo) {
      const r = parseDateRangeFlags(opts.compareFrom, opts.compareTo)
      if (!r) { console.error('\n  Invalid --compare-from/--compare-to dates.\n'); process.exit(1) }
      rangeB = r
      labelB = formatDateRangeLabel(opts.compareFrom ?? '', opts.compareTo ?? '')
    } else {
      const dur = rangeA.end.getTime() - rangeA.start.getTime()
      rangeB = { start: new Date(rangeA.start.getTime() - dur), end: new Date(rangeA.start.getTime()) }
      labelB = `prev ${opts.period}`
    }

    const [projectsA, projectsB] = await Promise.all([
      parseAllSessions(rangeA, opts.provider),
      parseAllSessions(rangeB, opts.provider),
    ])

    const agg = (ps: ProjectSummary[]) => {
      const sess = ps.flatMap(p => p.sessions)
      const cost = ps.reduce((s, p) => s + p.totalCostUSD, 0)
      const calls = ps.reduce((s, p) => s + p.totalApiCalls, 0)
      const inp = sess.reduce((s, ss) => s + ss.totalInputTokens, 0)
      const cr = sess.reduce((s, ss) => s + ss.totalCacheReadTokens, 0)
      return { cost, calls, sessions: sess.length, cacheHit: inp + cr > 0 ? (cr / (inp + cr)) * 100 : 0 }
    }
    const a = agg(projectsA), b = agg(projectsB)

    const pctDelta = (curr: number, prev: number) => {
      if (prev === 0) return curr > 0 ? '+inf' : '─'
      const p = ((curr - prev) / prev) * 100
      return (p >= 0 ? '+' : '') + p.toFixed(1) + '%'
    }

    if (opts.format === 'json') {
      console.log(JSON.stringify({ a: { label: labelA, ...a }, b: { label: labelB, ...b } }, null, 2))
      return
    }

    const COL = 13, LBL = 20
    const la = labelA.slice(0, COL), lb = labelB.slice(0, COL)
    console.log(`\n  Diff  ·  ${labelA}  vs  ${labelB}\n`)
    console.log(`  ${''.padEnd(LBL)}  ${la.padStart(COL)}  ${lb.padStart(COL)}  ${'Change'.padStart(10)}`)
    console.log(`  ${'─'.repeat(LBL + 2 + COL + 2 + COL + 2 + 10)}`)
    const row = (lbl: string, va: string, vb: string, d: string) =>
      console.log(`  ${lbl.padEnd(LBL)}  ${va.padStart(COL)}  ${vb.padStart(COL)}  ${d.padStart(10)}`)
    row('Cost', formatCost(a.cost), formatCost(b.cost), pctDelta(a.cost, b.cost))
    row('API Calls', a.calls.toLocaleString(), b.calls.toLocaleString(), pctDelta(a.calls, b.calls))
    row('Sessions', String(a.sessions), String(b.sessions), pctDelta(a.sessions, b.sessions))
    row('Cache hit rate', `${a.cacheHit.toFixed(1)}%`, `${b.cacheHit.toFixed(1)}%`, pctDelta(a.cacheHit, b.cacheHit))
    console.log()
  })

program.parse()
