import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationId, JsonObject } from '@earendil-works/pi-durable'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { context } from '../server/harness.ts'
import { Messages } from '../extensions/messages/api.ts'
import { Standing } from '../extensions/subagents/api.ts'
import { Summaries, setAutomaticSummaries } from '../extensions/conversations/summary.ts'
import { liveInstructions } from '../extensions/voice-live/server.ts'
import type { VoiceAnswer, VoiceLine } from '../extensions/voice-live/refs.ts'
import { Activity } from '../extensions/voice-live/activity.ts'
import { writeSecret } from '../extensions/secrets/store.ts'
import { fauxServer, held, post, sourceCopy, temp, until } from './helpers.ts'

let ultimateRoot: string
const servers: Awaited<ReturnType<typeof fauxServer>>[] = []
beforeAll(async () => {
  ultimateRoot = await sourceCopy(await temp())
  const path = join(ultimateRoot, 'extensions/voice-live/agents/voice.md')
  await writeFile(
    path,
    (await readFile(path, 'utf8')).replace('openai-codex/gpt-6-luna', 'faux/faux-1'),
  )
  await writeFile(
    join(ultimateRoot, '.ultimate/settings.json'),
    JSON.stringify({ summaryModel: 'unavailable/test', extensions: { enable: ['voice-live'] } }),
  )
})
afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()))
})

it.each([false, true])('loads Voice agents and facets only when enabled (%s)', async (enabled) => {
  const home = await temp('ultimate-voice-toggle-')
  const projectRoot = join(home, 'project')
  await mkdir(join(projectRoot, '.ultimate'), { recursive: true })
  await writeFile(
    join(projectRoot, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { enable: enabled ? ['voice-live'] : [] } }),
  )
  const probe = join(projectRoot, '.ultimate/extensions/probe')
  await mkdir(probe, { recursive: true })
  await writeFile(
    join(probe, 'server.ts'),
    `import { SubagentsApi } from ${JSON.stringify(join(ultimateRoot, 'extensions/subagents/api.ts'))}
export const actions = {
  residents: (_args, { host, signal }) => host.need(SubagentsApi).residents({ signal }),
}
export default { name: 'probe' }
`,
  )
  const server = await fauxServer({ ultimateRoot, projectRoot, home, userHome: home })
  servers.push(server)
  const residents = await post(server, '/api/extensions/probe/actions/residents', { args: null })
  expect([
    residents.status,
    residents.data.error,
    server.extensions.info().find((e) => e.name === 'probe')?.server?.error,
  ]).toEqual([200, undefined, undefined])
  expect(residents.data.result.some((agent: { name: string }) => agent.name === 'voice')).toBe(
    enabled,
  )
  const info = server.extensions.info().find((extension) => extension.name === 'voice-live')!
  expect(info.enabled).toBe(enabled)
  expect(Boolean(info.server)).toBe(enabled)
  const webFacets = Object.keys(
    (await server.vite.ssrLoadModule('virtual:ultimate/web-facets')).loaders,
  )
  expect(webFacets.some((path) => path.includes('/voice-live/'))).toBe(enabled)
  const rootAgent = await server.root.agent(context)
  expect(
    [...rootAgent.tools, ...rootAgent.deferred].some((tool) => tool.name.startsWith('voice_')),
  ).toBe(enabled)
  const definitions = await post(server, '/api/extensions/subagents/actions/definitions', {
    args: null,
  })
  expect(
    definitions.data.result.definitions.some((agent: { name: string }) => agent.name === 'voice'),
  ).toBe(enabled)
  if (!enabled) return
  // Extension-owned definitions stay built-ins, with both overlay scopes and edits read on demand.
  for (const [directory, text] of [
    [join(home, '.ultimate/agents'), 'User voice additions.'],
    [join(projectRoot, '.ultimate/agents'), 'Project voice additions.'],
  ]) {
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'voice.md'), `---\nname: voice\naddTools: []\n---\n\n${text}\n`)
  }
  const definition = await post(server, '/api/extensions/subagents/actions/definition', {
    args: { name: 'voice' },
  })
  expect(definition.data.result.definition).toMatchObject({
    source: 'builtin',
    instructions: expect.stringContaining('User voice additions.'),
    overlays: [
      join(home, '.ultimate/agents/voice.md'),
      join(projectRoot, '.ultimate/agents/voice.md'),
    ],
  })
  expect(definition.data.result.definition.instructions).toContain('Project voice additions.')
  const standing = await post(server, '/api/extensions/subagents/actions/standing', {
    args: { name: 'voice' },
  })
  expect(standing.status).toBe(200)
  // Retiring a definition preserves its conversation as history, not a standing agent.
  await rm(join(home, '.ultimate/agents/voice.md'))
  await rm(join(projectRoot, '.ultimate/agents/voice.md'))
  await writeFile(
    join(projectRoot, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { disable: ['voice-live'] } }),
  )
  await until(
    async () => !(await server.harness.snapshot(Standing, ROOT_CONVERSATION_ID, context))?.voice,
  )
  expect(
    await server.harness.conversation(standing.data.result as ConversationId, context),
  ).toBeDefined()
  const retired = await post(server, '/api/extensions/conversations/actions/conclude', {
    args: { ids: [standing.data.result] },
  })
  expect(retired.status).toBe(200)
})

async function fixture() {
  const home = await temp('ultimate-voice-live-')
  const server = await fauxServer({ ultimateRoot, home, userHome: home })
  servers.push(server)
  const standing = await post(server, '/api/extensions/subagents/actions/standing', {
    args: { name: 'ultimate' },
  })
  expect(standing.status).toBe(200)
  const main = standing.data.result as ConversationId
  await server.harness.commit((tx) => setAutomaticSummaries(tx, main, false), context)
  await until(
    async () =>
      (await post(server, '/api/extensions/automations/actions/list', { args: null })).data.result
        .length > 0,
  )
  await writeSecret(home, 'OPENAI_API_KEY', 'sk-test-not-real')
  let sessions = 0
  const startSession = async () => {
    const originalFetch = globalThis.fetch
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) =>
      url === 'https://api.openai.com/v1/live/sessions'
        ? Promise.resolve(
            Response.json({
              session: { id: `fake-live-${++sessions}` },
              transport: { type: 'webrtc', sdp: 'fake-answer' },
            }),
          )
        : originalFetch(url, init),
    )
    try {
      const result = await post(server, '/api/extensions/voice-live/actions/start', {
        args: { sdp: 'fake-offer' },
      })
      expect([result.status, result.data.error]).toEqual([200, undefined])
      const [, request] = fetch.mock.calls.find(
        ([target]) => target === 'https://api.openai.com/v1/live/sessions',
      )!
      expect(JSON.parse(request!.body as string).session.instructions).toBe(liveInstructions())
      return result.data.result.conversation as ConversationId
    } finally {
      fetch.mockRestore()
    }
  }
  const voice = await startSession()
  const requests: string[][] = []
  const answers: string[] = []
  let answer = 'The tests pass.'
  const call = (name: string, args: JsonObject) =>
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' })
  const route: FauxResponseFactory = (...args) => {
    const [transcript] = args
    server.host.faux!.appendResponses([route])
    const system = JSON.stringify(transcript.messages.filter((m) => m.role === 'system'))
    const last = transcript.messages.findLast((m) => m.role !== 'system')!
    const text = typeof last.content === 'string' ? last.content : JSON.stringify(last.content)
    if (system.includes('You are the voice in the user')) {
      requests.push(
        transcript.messages.flatMap((m) =>
          m.role === 'user' && typeof m.content === 'string' ? [m.content] : [],
        ),
      )
      if (last.role === 'toolResult') return call('voice_say', { text: 'Passing that on.' })
      if (text.startsWith('@ultimate answered')) {
        answers.push(text)
        return call('voice_say', { text: 'The spoken answer. Details are on screen.' })
      }
      if (text.includes('can you hear me'))
        return call('voice_say', { text: 'Yes, I can hear you.' })
      return call('voice_ask_ultimate', {
        request: text.includes('small fix') ? 'Use the small fix.' : 'Please check the tests.',
      })
    }
    if (answer === 'QUESTION')
      return call('message', {
        to: 'user',
        text: 'Which approach?',
        questions: [
          {
            ref: '1',
            text: 'Approach?',
            kind: 'choice',
            options: [
              { key: 'a', label: 'Small fix' },
              { key: 'b', label: 'Rewrite' },
            ],
          },
        ],
      })
    if (answer === 'HOLD') return held(...args)
    return fauxAssistantMessage(answer)
  }
  server.host.faux!.setResponses([route])
  const action = async (name: string, args: unknown) => {
    const result = await post(server, `/api/extensions/voice-live/actions/${name}`, { args })
    expect([result.status, result.data.error]).toEqual([200, undefined])
    return result.data.result
  }
  const entries = (id: ConversationId) =>
    server.harness.commit(
      async (tx) => (await tx.scanEntries({ conversationId: id, order: 'ascending' }, 1000)).items,
      context,
    )
  const waitAnswer = async (count: number) => {
    await until(
      async () =>
        (await entries(voice)).filter(
          (e) => e.kind === 'voice.line' && (e.data as VoiceLine).re !== undefined,
        ).length === count,
    )
    return (await entries(voice))
      .filter((e) => e.kind === 'voice.line' && (e.data as VoiceLine).re !== undefined)
      .at(-1)!
  }
  return {
    server,
    main,
    voice,
    startSession,
    requests,
    action,
    entries,
    answers,
    waitAnswer,
    setAnswer: (text: string) => {
      answer = text
    },
  }
}

it('delivers a stopped-input notice and agent input with distinct request ids', async () => {
  const f = await fixture()
  f.setAnswer('HOLD')
  await f.action('heard', { text: 'check tests' })
  await until(async () => (await f.entries(f.main)).some((e) => e.kind === 'voice.utterance'))
  await (await f.server.harness.conversation(f.main, context))!.abort(context)
  await until(() => f.answers.length > 0)
  expect(f.answers[0]).toContain('Ultimate did not answer that request.')
  const lines = (await f.entries(f.voice)).filter((e) => e.kind === 'voice.line')
  const forwarded = lines.find((e) => (e.data as VoiceLine).forwarded)!
  expect(lines.find((e) => (e.data as VoiceLine).role === 'notice')?.data).toMatchObject({
    role: 'notice',
    re: forwarded.id,
    text: 'Ultimate was stopped before it answered.',
  })
})

it('leaves a notice for a forwarded line whose answer task is aborted', async () => {
  const f = await fixture()
  f.setAnswer('HOLD')
  await f.action('heard', { text: 'check tests' })
  await until(async () => (await f.entries(f.main)).some((e) => e.kind === 'voice.utterance'))
  const tasks = await f.server.harness.commit(
    async (tx) => (await tx.scanTasks({ kind: 'voice-live.answer' }, 10)).items,
    context,
  )
  expect(tasks).toHaveLength(1)
  await f.server.harness.abortTask(tasks[0].id, context)
  await until(() => f.answers.length > 0)
  const lines = (await f.entries(f.voice)).filter((e) => e.kind === 'voice.line')
  const forwarded = lines.find((e) => (e.data as VoiceLine).forwarded)!
  expect(lines.filter((e) => (e.data as VoiceLine).role === 'notice').map((e) => e.data)).toEqual([
    {
      role: 'notice',
      text: 'Ultimate was stopped before it answered.',
      re: forwarded.id,
      at: expect.any(Number),
    },
  ])
  expect(f.answers[0]).toContain('Ultimate did not answer that request.')
})

it('answers a connection check itself in the standing Voice conversation, with its relay tools and codemode', async () => {
  const f = await fixture()
  expect((await f.server.harness.snapshot(Standing, ROOT_CONVERSATION_ID, context))?.voice).toBe(
    f.voice,
  )
  const agent = await (await f.server.harness.conversation(f.voice, context))!.agent(context)
  expect(agent.tools.map((t) => t.name).toSorted()).toEqual([
    'codemode',
    'voice_ask_ultimate',
    'voice_note',
    'voice_say',
  ])
  expect((await f.server.harness.snapshot(Summaries, f.voice, context))?.automatic).toBe(false)
  await f.action('heard', { text: 'can you hear me' })
  await until(async () => (await f.entries(f.voice)).some((e) => e.kind === 'voice.line'))
  await (await f.server.harness.conversation(f.voice, context))!.waitForIdle(context)
  const lines = (await f.entries(f.voice)).filter((e) => e.kind === 'voice.line')
  expect(lines.map((e) => e.data)).toEqual([
    { role: 'ultimate', text: 'Yes, I can hear you.', speech: true, at: expect.any(Number) },
  ])
  expect((await f.entries(f.voice)).find((e) => e.kind === 'voice.heard')?.data).toEqual({
    text: 'can you hear me',
    at: expect.any(Number),
  })
  expect((await f.entries(f.main)).filter((e) => e.kind === 'voice.utterance')).toHaveLength(0)
})

it('forwards the cleaned request and feeds the actual answer back to Voice to speak, linked to its forwarded line', async () => {
  const f = await fixture()
  await f.action('heard', { text: 'Um please, can you check the tests for me' })
  const spoken = await f.waitAnswer(1)
  const forwarded = (await f.entries(f.voice)).find(
    (e) => e.kind === 'voice.line' && (e.data as VoiceLine).forwarded,
  )!
  expect(forwarded.data).toEqual({
    role: 'user',
    forwarded: true,
    text: 'Please check the tests.',
    at: expect.any(Number),
  })
  expect((await f.entries(f.main)).find((e) => e.kind === 'voice.utterance')?.data).toEqual({
    text: 'Please check the tests.',
    line: forwarded.id,
  })
  expect(f.answers).toEqual([
    `@ultimate answered (to forwarded line ${forwarded.id}):\nThe tests pass.`,
  ])
  // The card's "Open in @ultimate" lands on the answer itself.
  const answer = (await f.entries(f.voice)).find((e) => e.kind === 'voice.answer')!
  const source = (answer.data as VoiceAnswer).source!
  expect(source.conversation).toBe(f.main)
  expect((await f.entries(f.main)).find((e) => e.id === source.entry)?.kind).toBe('pi.assistant')
  expect(spoken.data).toEqual({
    role: 'ultimate',
    text: 'The spoken answer. Details are on screen.',
    speech: true,
    re: forwarded.id,
    at: expect.any(Number),
  })
  // The session counts the user's line and both spoken ones, and the request passed on and answered.
  await until(
    async () => (await f.server.harness.snapshot(Activity, f.voice, context))?.messages === 3,
  )
  expect(await f.server.harness.snapshot(Activity, f.voice, context)).toMatchObject({
    messages: 3,
    relayed: 1,
    waiting: 0,
    via: 'browser',
  })
  await f.action('end', { seconds: 23 })
  expect((await f.entries(f.voice)).at(-1)?.data).toMatchObject({ phase: 'ended', seconds: 23 })
})

it('speaks a tool-terminated question and answers it through Messages, without a new utterance', async () => {
  const f = await fixture()
  f.setAnswer('QUESTION')
  await f.action('heard', { text: 'Please propose an approach' })
  await f.waitAnswer(1)
  const log = (await f.server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context))!
  const question = log.messages.findLast((m) => m.from === f.main && m.to === 'user')!
  expect(question.state).toBe('delivered')
  expect(f.answers[0]).toContain('Which approach?')
  expect(f.answers[0]).toContain('a: Small fix')
  expect(f.answers[0]).toContain('b: Rewrite')
  f.setAnswer('I will use the small fix.')
  await f.action('heard', { text: 'The small fix please' })
  await f.waitAnswer(2)
  expect(f.answers[1]).toContain('I will use the small fix.')
  expect(
    (await f.server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context))?.messages.find(
      (m) => m.id === question.id,
    )?.state,
  ).toBe('answered')
  expect((await f.entries(f.main)).filter((e) => e.kind === 'voice.utterance')).toHaveLength(1)
  expect((await f.entries(f.main)).some((e) => e.kind === 'board.message')).toBe(true)
})

it('briefs each session, waits for the brief before the first line, and lets only the newest reach Voice', async () => {
  const f = await fixture()
  const briefs = async () => (await f.entries(f.voice)).filter((e) => e.kind === 'voice.context')
  await until(async () => (await briefs()).length === 1)
  expect((await briefs())[0].data).toMatchObject({ requests: 0, branches: 0, transient: true })
  expect((await briefs())[0].model?.[0]).toMatchObject({ role: 'user' })
  // @ultimate gets a request, then a second session starts while its brief is held back.
  await f.action('heard', { text: 'please check the tests' })
  await f.waitAnswer(1)
  const gate = Promise.withResolvers<void>()
  const conversation = f.server.harness.conversation.bind(f.server.harness)
  let opened = 0
  const spy = vi.spyOn(f.server.harness, 'conversation').mockImplementation(async (id, ctx) => {
    const found = await conversation(id, ctx)
    if (id === f.voice) opened++
    if (id !== f.main || !found) return found
    return Object.assign(Object.create(found), {
      entries: async (...args: Parameters<typeof found.entries>) => {
        await gate.promise
        return found.entries(...args)
      },
    })
  })
  try {
    await f.startSession()
    const before = opened
    const snapshot = f.server.harness.snapshot.bind(f.server.harness)
    const receiving = Promise.withResolvers<void>()
    const snapshotSpy = vi
      .spyOn(f.server.harness, 'snapshot')
      .mockImplementation(async (...args) => {
        const value = await snapshot(...args)
        if (args[0].definition.kind === Standing.definition.kind) receiving.resolve()
        return value
      })
    try {
      const heard = f.action('heard', { text: 'what was that about' })
      await receiving.promise
      // The heard action has read its recipient but the held brief keeps the line out of Voice's conversation.
      expect((await f.entries(f.voice)).filter((e) => e.kind === 'voice.heard')).toHaveLength(1)
      expect(opened).toBe(before)
      gate.resolve()
      await heard
    } finally {
      snapshotSpy.mockRestore()
    }
  } finally {
    gate.resolve()
    spy.mockRestore()
  }
  const all = await f.entries(f.voice)
  const second = all.filter((e) => e.kind === 'voice.context')[1]
  const line = all.findLast((e) => e.kind === 'voice.heard')!
  expect(second.id).toBeLessThan(line.id)
  expect(second.data).toMatchObject({ requests: 1 })
  expect((second.data as { text: string }).text).toContain('Please check the tests.')
  expect(second.edits).toEqual([{ target: (await briefs())[0].id, action: 'omit' }])
  await (await f.server.harness.conversation(f.voice, context))!.waitForIdle(context)
  // Voice's request on that line carries the new brief once, and not the old one.
  const seen = f.requests.at(-1)!.filter((m) => m.startsWith('<voice_context>'))
  expect(seen).toEqual([(second.data as { text: string }).text])
})

it('drives Voice from a phone without a key: heard once per id, summary kept on the line', async () => {
  const home = await temp('ultimate-voice-phone-')
  const projectRoot = join(home, 'project')
  await mkdir(join(projectRoot, '.ultimate/extensions/phone'), { recursive: true })
  await writeFile(
    join(projectRoot, '.ultimate/settings.json'),
    JSON.stringify({ summaryModel: 'unavailable/test', extensions: { enable: ['voice-live'] } }),
  )
  await writeFile(
    join(projectRoot, '.ultimate/extensions/phone/server.ts'),
    `import { VoiceLiveApi } from ${JSON.stringify(join(ultimateRoot, 'extensions/voice-live/api.ts'))}
export const actions = {
  open: (args, { host }) => host.need(VoiceLiveApi).open(args.session),
  heard: (args, { host }) => host.need(VoiceLiveApi).heard(args.text, args.id),
  conversation: (_args, { host }) => host.need(VoiceLiveApi).conversation(),
}
export default { name: 'phone' }
`,
  )
  const server = await fauxServer({ ultimateRoot, projectRoot, home, userHome: home })
  servers.push(server)
  const phone = async (name: string, args: unknown) => {
    const result = await post(server, `/api/extensions/phone/actions/${name}`, { args })
    expect([result.status, result.data.error]).toEqual([200, undefined])
    return result.data.result
  }
  expect(await phone('conversation', null)).toBeUndefined()
  const voice = (await phone('open', { session: 'p1' })) as ConversationId
  expect(await phone('conversation', null)).toBe(voice)
  expect(await phone('open', { session: 'p1' })).toBe(voice)
  server.host.faux!.setResponses([
    () =>
      fauxAssistantMessage(
        [
          fauxToolCall('voice_say', {
            text: 'Hello there, good to hear you.',
            summary: 'Greeted.',
          }),
        ],
        { stopReason: 'toolUse' },
      ),
  ])
  await phone('heard', { text: ' hello ', id: 'h1' })
  await phone('heard', { text: ' hello ', id: 'h1' })
  const conversation = (await server.harness.conversation(voice, context))!
  await until(async () => (await conversation.agent(context)) !== undefined)
  await conversation.waitForIdle(context)
  const entries = (
    await server.harness.commit(
      (tx) => tx.scanEntries({ conversationId: voice, order: 'ascending' }, 1000),
      context,
    )
  ).items
  expect(entries.filter((e) => e.kind === 'voice.session').map((e) => e.data)).toEqual([
    { phase: 'started', at: expect.any(Number), via: 'phone' },
  ])
  const heard = entries.filter((e) => e.kind === 'voice.heard')
  expect(heard.map((e) => e.data)).toEqual([
    { text: 'hello', via: 'phone', at: expect.any(Number) },
  ])
  const brief = entries.find((e) => e.kind === 'voice.context')!
  expect(brief.id).toBeLessThan(heard[0].id)
  expect(JSON.stringify(heard[0].model)).toContain('on their phone')
  expect(entries.filter((e) => e.kind === 'voice.line').map((e) => e.data)).toEqual([
    {
      role: 'ultimate',
      text: 'Hello there, good to hear you.',
      speech: true,
      summary: 'Greeted.',
      at: expect.any(Number),
    },
  ])
  await until(async () => (await server.harness.snapshot(Activity, voice, context))?.messages === 2)
  expect((await server.harness.snapshot(Activity, voice, context))?.via).toBe('phone')
  // An agent built on Voice that replaces it becomes the relay, keeping the conversation and its history.
  await mkdir(join(home, '.ultimate/agents'), { recursive: true })
  await writeFile(
    join(home, '.ultimate/agents/relay.md'),
    '---\nname: relay\nextends: voice\nformerly: [voice]\n---\n\nYou are called Relay.\n',
  )
  expect(await phone('open', { session: 'p2' })).toBe(voice)
  expect(await phone('conversation', null)).toBe(voice)
  const standing = await server.harness.snapshot(Standing, ROOT_CONVERSATION_ID, context)
  expect([standing?.relay, standing?.voice]).toEqual([voice, undefined])
  const relay = await post(server, '/api/extensions/subagents/actions/definition', {
    args: { name: 'relay' },
  })
  expect(relay.data.result.definition.instructions).toMatch(
    /^You are the voice in the user's ear[\s\S]*You are called Relay\.$/,
  )
})
