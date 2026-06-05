import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

function runCli(args: string[], home: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      HOME: home,
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
    message: { role: 'user', content: 'add feature' },
  })
}

function assistantLine(sessionId: string, timestamp: string, messageId: string): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId,
    timestamp,
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text: 'done' }],
      usage: {
        input_tokens: 100,
        output_tokens: 10,
      },
    },
  })
}

describe('codeburn export-schedule', () => {
  it('writes a timestamped markdown snapshot into a folder', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-export-sched-'))
    try {
      const projectDir = join(home, '.claude', 'projects', 'app')
      await mkdir(projectDir, { recursive: true })
      await writeFile(
        join(projectDir, 'session.jsonl'),
        [
          userLine('sched-1', '2026-06-04T09:00:00Z'),
          assistantLine('sched-1', '2026-06-04T09:01:00Z', 'msg-1'),
        ].join('\n'),
      )

      const outputDir = join(home, 'exports')
      const result = runCli([
        'export-schedule',
        '--format', 'markdown',
        '--runs', '1',
        '--output', outputDir,
        '--provider', 'claude',
        '--from', '2026-06-04',
        '--to', '2026-06-04',
      ], home)

      expect(result.status).toBe(0)
      const entries = await readdir(outputDir)
      expect(entries.some(name => name.endsWith('.md'))).toBe(true)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
