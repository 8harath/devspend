import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

function runCli(args: string[], home: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      HOMEPATH: home,
      HOMEDRIVE: '',
      TZ: 'UTC',
    },
    encoding: 'utf-8',
  })
}

function userLine(sessionId: string, timestamp: string): string {
  return JSON.stringify({
    type: 'user',
    sessionId,
    timestamp,
    message: { role: 'user', content: 'do the thing' },
  })
}

function assistantLine(sessionId: string, timestamp: string, messageId: string, model: string): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId,
    timestamp,
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model,
      content: [
        { type: 'text', text: 'done' },
      ],
      usage: { input_tokens: 1000, output_tokens: 100 },
    },
  })
}

describe('codeburn budget and alert scopes', () => {
  it('persists project, model, and directory budgets and flags breaches', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-budget-alerts-'))

    try {
      const projectDir = join(home, '.claude', 'projects', 'myapp')
      await mkdir(projectDir, { recursive: true })
      const base = new Date()
      const ts1 = base.toISOString()
      const ts2 = new Date(base.getTime() + 60_000).toISOString()

      await writeFile(
        join(projectDir, 'session.jsonl'),
        [
          userLine('s1', ts1),
          assistantLine('s1', ts2, 'msg-1', 'claude-sonnet-4-5'),
        ].join('\n'),
      )

      expect(runCli(['budget', 'set', 'myapp', '0.0000000001'], home).status).toBe(0)
      expect(runCli(['budget', 'set', '--model', 'claude-sonnet-4-5', '0.0000000001'], home).status).toBe(0)
      expect(runCli(['budget', 'set', '--dir', projectDir, '0.0000000001'], home).status).toBe(0)

      const configPath = join(home, '.config', 'devspend', 'config.json')
      const configRaw = await readFile(configPath, 'utf-8')
      const config = JSON.parse(configRaw) as { budgets?: Record<string, { monthlyUsd?: number }> }
      expect(config.budgets?.['project:myapp']?.monthlyUsd).toBe(0.0000000001)
      expect(config.budgets?.['model:claude-sonnet-4-5']?.monthlyUsd).toBe(0.0000000001)
      expect(config.budgets?.[`directory:${projectDir}`]?.monthlyUsd).toBe(0.0000000001)

      const status = runCli(['budget'], home)
      expect(status.status).toBe(1)
      expect(status.stdout).toContain('myapp')
      expect(status.stdout).toContain('model:claude-sonnet-4-5')
      expect(status.stdout).toContain('directory:')
      expect(status.stdout).toContain('myapp')

      const alertCheck = runCli(['alert', 'check'], home)
      expect(alertCheck.status).toBe(1)
      expect(alertCheck.stderr).toContain('ALERT:')
      expect(alertCheck.stderr).toContain('project budget')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
