import { describe, expect, it } from 'vitest'

import { summarizeBudgets } from '../src/main.js'
import type { ProjectSummary } from '../src/types.js'

describe('summarizeBudgets', () => {
  it('classifies project, model, and directory budgets', () => {
    const projects: ProjectSummary[] = [
      {
        project: 'myapp',
        projectPath: '/work/myapp',
        totalCostUSD: 12,
        totalApiCalls: 1,
        sessions: [
          {
            sessionId: 's1',
            project: 'myapp',
            firstTimestamp: '2026-06-01T10:00:00.000Z',
            lastTimestamp: '2026-06-01T10:01:00.000Z',
            totalCostUSD: 12,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalCacheReadTokens: 0,
            totalCacheWriteTokens: 0,
            apiCalls: 1,
            turns: [],
            modelBreakdown: {
              'claude-sonnet-4-5': {
                calls: 1,
                costUSD: 12,
                tokens: {
                  inputTokens: 0,
                  outputTokens: 0,
                  cacheCreationInputTokens: 0,
                  cacheReadInputTokens: 0,
                  cachedInputTokens: 0,
                  reasoningTokens: 0,
                  webSearchRequests: 0,
                },
              },
            },
            toolBreakdown: {},
            mcpBreakdown: {},
            bashBreakdown: {},
            categoryBreakdown: {},
            skillBreakdown: {},
          },
        ],
      },
    ]

    const rows = summarizeBudgets(projects, {
      'project:myapp': { monthlyUsd: 10, setAt: '2026-06-01T00:00:00.000Z' },
      'model:claude-sonnet-4-5': { monthlyUsd: 10, setAt: '2026-06-01T00:00:00.000Z' },
      'directory:/work': { monthlyUsd: 10, setAt: '2026-06-01T00:00:00.000Z' },
    })

    expect(rows.map(row => `${row.target.scope}:${row.target.label}:${row.status}`)).toEqual([
      'directory:/work:OVER',
      'model:claude-sonnet-4-5:OVER',
      'project:myapp:OVER',
    ])
  })
})
