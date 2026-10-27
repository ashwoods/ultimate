import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationId, JsonObject, LiveState } from '@earendil-works/pi-durable'
import { context } from '../server/harness.ts'
import { createFeed, harnessSource, phaseOf } from '../extensions/phone/feed.ts'
import type { FeedItem, JobItem } from '../extensions/phone/feed.ts'
import { methods } from '../extensions/phone/methods.ts'
import type { Call, Services } from '../extensions/phone/methods.ts'
import type { VoiceLiveService } from '../extensions/voice-live/api.ts'
import { setAutomaticSummaries } from '../extensions/conversations/summary.ts'
import { FakeSource, fakeVoice } from './phone-fakes.ts'
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
})
afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()))
})

/** A real server with Voice and @ultimate on faux models; the phone's side is the feed and `say` over Voice's API. */
async function fixture() {
  const home = await temp('ultimate-phone-feed-')
  const projectRoot = join(home, 'project')
  await mkdir(join(projectRoot, '.ultimate/extensions/probe'), { recursive: true })
  await writeFile(
    join(projectRoot, '.ultimate/settings.json'),
    JSON.stringify({ summaryModel: 'unavailable/test', extensions: { enable: ['voice-live'] } }),
  )
  await writeFile(
    join(projectRoot, '.ultimate/extensions/probe/server.ts'),
    `import { VoiceLiveApi } from ${JSON.stringify(join(ultimateRoot, 'extensions/voice-live/api.ts'))}
export const actions = {
  open: (args, { host }) => host.need(VoiceLiveApi).open(args.session),
  heard: (args, { host }) => host.need(VoiceLiveApi).heard(args.text, args.id),
  conversation: (_args, { host }) => host.need(VoiceLiveApi).conversation(),
}
export default { name: 'probe' }
`,
  )
  const server = await fauxServer({ ultimateRoot, projectRoot, home, userHome: home })
  servers.push(server)
  const standing = await post(server, '/api/extensions/subagents/actions/standing', {
    args: { name: 'ultimate' },
  })
  const main = standing.data.result as ConversationId
  await server.harness.commit((tx) => setAutomaticSummaries(tx, main, false), context)
  const probe = async (name: string, args: unknown) => {
    const result = await post(server, `/api/extensions/probe/actions/${name}`, { args })
    expect([result.status, result.data.error]).toEqual([200, undefined])
    return result.data.result
  }
  // The service `say` talks into, as the phone extension gets it from voice-live.
  const voice: VoiceLiveService = {
    open: (session) => probe('open', { session }),
    heard: (text, id) => probe('heard', { text, id }),
    conversation: () => probe('conversation', null),
  }
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
      if (last.role === 'toolResult') return call('voice_say', { text: 'Passing that on.' })
      if (text.startsWith('@ultimate answered'))
        return call('voice_say', {
          text: 'The spoken answer. Details are on screen.',
          summary: 'Tests pass.',
        })
      return call('voice_ask_ultimate', { request: 'Please check the tests.' })
    }
    if (answer === 'HOLD') return held(...args)
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
    return fauxAssistantMessage(answer)
  }
  server.host.faux!.setResponses([route])
  const phone = await probe('open', { session: 'p1' })
  const feed = createFeed(harnessSource({ harness: () => server.harness }, voice))
  const events: FeedItem[][] = []
  feed.start()
  const { items } = await feed.join(50, (changed) => events.push(changed))
  expect(items).toEqual([])
  // The newest version of an item among the events.
  const latest = (id: number) => events.flat().findLast((item) => item.id === id)
  const say = async (id: string, text: string) => {
    const services = { voice } as unknown as Services
    const phoneCall: Call = {
      services,
      device: { id: 'phone', key: Buffer.alloc(32) },
      signal: new AbortController().signal,
      emit: () => {},
    }
    expect(await methods.say({ id, text, via: 'voice' }, phoneCall)).toEqual({})
  }
  return {
    server,
    main,
    phone,
    feed,
    events,
    latest,
    say,
    setAnswer: (text: string) => void (answer = text),
    stop: () => feed.stop(),
  }
}

it("builds the feed from Voice: heard, a job that works then is answered with Voice's speech, and said lines", async () => {
  const f = await fixture()
  f.setAnswer('QUESTION')
  await f.say('h1', 'Please check the tests')
  await until(() =>
    f.events.flat().some((item) => item.kind === 'job' && item.state === 'answered'),
  )
  const job = f.events.flat().find((item) => item.kind === 'job')!
  const heard = f.events.flat().find((item) => item.kind === 'heard')!
  expect(heard).toMatchObject({ text: 'Please check the tests', at: expect.any(Number) })
  // The job went out as working first, and its answer came with a question @ultimate asked.
  const states = f.events.flat().filter((item) => item.id === job.id)
  expect(states[0]).toMatchObject({
    kind: 'job',
    state: 'working',
    request: 'Please check the tests.',
  })
  await until(() => (f.latest(job.id) as JobItem).speech !== undefined)
  const done = f.latest(job.id) as JobItem
  expect(done).toMatchObject({
    state: 'answered',
    speech: 'The spoken answer. Details are on screen.',
    summary: 'Tests pass.',
    detail: expect.stringContaining('Which approach?'),
  })
  expect(done.phase).toBeUndefined()
  // Voice's remark made while it was working is a said item, not a job.
  expect(f.events.flat().find((item) => item.kind === 'said')).toMatchObject({
    text: 'Passing that on.',
  })
  // The open question @ultimate asked is the Messages entry, linked on the job.
  expect(done.question).toEqual(expect.any(Number))
  // A phone that subscribes later gets the same items in one snapshot, oldest first.
  const snapshot = (await f.feed.join(50, () => {})).items
  expect(snapshot.map((item) => item.id)).toEqual(
    snapshot.map((item) => item.id).toSorted((a, b) => a - b),
  )
  expect(snapshot.find((item) => item.id === job.id)).toEqual(done)
  f.stop()
})

it('shows what @ultimate is doing while a job works, and fails the job when @ultimate is stopped', async () => {
  const f = await fixture()
  f.setAnswer('HOLD')
  await f.say('h1', 'Please check the tests')
  await until(() =>
    f.events.flat().some((item) => item.kind === 'job' && item.phase === 'Thinking'),
  )
  const job = f.events.flat().find((item) => item.kind === 'job')!
  expect(f.latest(job.id)).toMatchObject({ state: 'working', phase: 'Thinking' })
  await (await f.server.harness.conversation(f.main, context))!.abort(context)
  await until(() => (f.latest(job.id) as JobItem).state === 'failed')
  expect(f.latest(job.id)).toMatchObject({
    state: 'failed',
    summary: 'Ultimate was stopped before it answered.',
  })
  expect((f.latest(job.id) as JobItem).phase).toBeUndefined()
  f.stop()
})

const step = (name: string, status: 'pending' | 'running' | 'done' = 'running') => ({
  callId: name,
  name,
  status,
})
it('names a running tool in a few words', () => {
  const run = { taskId: 1, inputs: [] } as unknown as NonNullable<LiveState['run']>
  expect(phaseOf(undefined)).toBeUndefined()
  expect(phaseOf({})).toBeUndefined()
  expect(phaseOf({ run })).toBe('Thinking')
  expect(phaseOf({ run, tools: [step('bash', 'done')] })).toBe('Thinking')
  expect(phaseOf({ run, tools: [step('bash')] })).toBe('Running a command')
  expect(phaseOf({ run, tools: [step('read', 'done'), step('codemode')] })).toBe(
    'Looking things up',
  )
  expect(phaseOf({ run, tools: [step('frobnicate')] })).toBe('frobnicate')
})

/** A feed over in-memory sources with a clock the test moves. */
function manual() {
  const source = new FakeSource()
  let clock = 1_000_000
  const timers: { at: number; run: () => void }[] = []
  const feed = createFeed(source, {
    now: () => clock,
    later: (ms, run) => {
      const timer = { at: clock + ms, run }
      timers.push(timer)
      return () => void timers.splice(timers.indexOf(timer), 1)
    },
  })
  const events: FeedItem[][] = []
  const advance = async (ms: number) => {
    clock += ms
    for (const timer of timers.filter((t) => t.at <= clock)) {
      timers.splice(timers.indexOf(timer), 1)
      timer.run()
    }
    await feed.refresh()
  }
  const run = { taskId: 1, inputs: [] } as unknown as NonNullable<LiveState['run']>
  return { source, feed, events, advance, run }
}

it('sends a changed phase at most once a second and delivers the held one later', async () => {
  const { source, feed, events, advance, run } = manual()
  source.add('voice.line', { role: 'user', forwarded: true, text: 'Check', at: 5 }, undefined)
  source.live = { run, tools: [step('read')] }
  await feed.join(50, (changed) => events.push(changed))
  const phases = () => events.flat().map((item) => (item as JobItem).phase)
  // The first change since the snapshot goes out at once.
  source.live = { run, tools: [step('bash')] }
  await feed.refresh()
  expect(phases()).toEqual(['Running a command'])
  // The next one inside the second is held, and a wake is waiting for it.
  source.live = { run, tools: [step('codemode')] }
  await feed.refresh()
  expect(phases()).toEqual(['Running a command'])
  await advance(1000)
  expect(phases()).toEqual(['Running a command', 'Looking things up'])
})

it('puts the open question on the newest job that began before it, and times lines by the message before them', async () => {
  const { source, feed } = manual()
  source.add('voice.heard', { text: 'first', via: 'phone' }, 100)
  const a = source.add('voice.line', { role: 'user', forwarded: true, text: 'A', at: 200 })
  const said = source.add('voice.line', { role: 'ultimate', speech: true, text: 'On it' })
  const b = source.add('voice.line', { role: 'user', forwarded: true, text: 'B', at: 300 })
  const ask = (state: 'delivered' | 'answered', at: number) =>
    ({ id: 9, from: 1, to: 'user', reply: true, state, at, text: 'Which?' }) as never
  source.log = [ask('delivered', 250)]
  const { items } = await feed.join(50, () => {})
  expect(items.map((item) => [item.kind, item.id, item.at])).toEqual([
    ['heard', expect.any(Number), 100],
    ['job', a, 200],
    ['said', said, 100],
    ['job', b, 300],
  ])
  expect(items.filter((item) => item.kind === 'job').map((item) => item.question)).toEqual([
    9,
    undefined,
  ])
  source.log = [ask('answered', 250)]
  expect(
    (await feed.join(50, () => {})).items.some((item) => 'question' in item && item.question),
  ).toBe(false)
})

it('keeps the newest limit items and reads only as far back as it needs', async () => {
  const { source, feed } = manual()
  for (let i = 0; i < 30; i++) source.add('voice.heard', { text: `line ${i}` }, 1000 + i)
  const { items } = await feed.join(3, () => {})
  expect(items.map((item) => (item as { text: string }).text)).toEqual([
    'line 27',
    'line 28',
    'line 29',
  ])
})

it('hands Voice a line once per channel session, however often the phone retries', async () => {
  const { voice, calls } = fakeVoice()
  const services = { voice } as unknown as Services
  const signal = new AbortController().signal
  const call = (): Call => ({
    services,
    device: { id: 'phone', key: Buffer.alloc(32) },
    signal,
    emit: () => {},
  })
  await methods.say({ id: 'a', text: ' hi ', via: 'voice' }, call())
  await methods.say({ id: 'a', text: ' hi ', via: 'voice' }, call())
  await methods.say({ id: 'b', text: 'typed', via: 'text' }, call())
  expect(calls.open).toHaveLength(1)
  expect(calls.open[0]).toMatch(/^phone:/)
  expect(calls.heard).toEqual([
    ['hi', 'a'],
    ['hi', 'a'],
    ['typed', 'b'],
  ])
  await expect(methods.say({ id: 'c', text: ' ', via: 'voice' }, call())).rejects.toThrow(
    'text is missing',
  )
  await expect(methods.say({ id: 'c', text: 'x', via: 'sms' }, call())).rejects.toThrow('via')
})
