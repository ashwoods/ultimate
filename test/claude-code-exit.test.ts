// fast-test-reason: spawn is only restored after the test; the child is a fake and no subprocess starts.
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, expect, it } from 'vitest'
import { discoverClaudeModels, useSpawn } from '@earendil-works/pi-claude-code/src/claude-cli.ts'

// Pi upstream: @earendil-works/pi-claude-code@0.1.0 src/claude-cli.ts childExit (patched). 'exit' may come before
// the output ends; lib/spawn.ts often delivers it that way, and discovery then waited forever (the claude-code e2e
// test timed out in every full e2e run). Drop with the matching pnpm patch when upstream fixes this.
afterEach(() => useSpawn(spawn))

it('finishes model discovery when Claude Code exits before its output ends', async () => {
  useSpawn((() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null,
      pid: 1,
    })
    let input = ''
    const stdin = new Writable({
      write: (chunk, _encoding, done) => ((input += chunk), done()),
      final: (done) => {
        done()
        const { request_id } = JSON.parse(input.split('\n')[0])
        child.exitCode = 0
        child.emit('exit', 0, null)
        const models = [{ value: 'sonnet', displayName: 'Sonnet', description: 'Sonnet' }]
        const response = { request_id, subtype: 'success', response: { models } }
        child.stdout.end(JSON.stringify({ type: 'control_response', response }) + '\n')
      },
    })
    return Object.assign(child, { stdin }) as unknown as ChildProcess
  }) as unknown as typeof spawn)

  const models = await discoverClaudeModels({ PI_CLAUDE_CODE_COMMAND: process.execPath })
  expect(models.map((model) => model.value)).toEqual(['sonnet'])
})
