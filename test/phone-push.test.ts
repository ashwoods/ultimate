import { createDecipheriv } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { writeSecret } from '../extensions/secrets/store.ts'
import type { ApnsRequest, ApnsResult } from '../extensions/phone/apns.ts'
import { b64u, deviceId, generateKeyPair, instanceId, pushKey } from '../extensions/phone/crypto.ts'
import type { JobItem } from '../extensions/phone/feed.ts'
import { ANSWER_WAIT, ACTIVITY_EVERY, Pusher, summaryOf } from '../extensions/phone/push.ts'
import { createPhone } from '../extensions/phone/runtime.ts'
import { loadState, macKeys, updateState } from '../extensions/phone/state.ts'
import type { RelaySocket } from '../extensions/phone/connector.ts'
import { FakeSource, fakeVoice } from './phone-fakes.ts'
import { temp, until } from './helpers.ts'

const job = (id: number, over: Partial<JobItem> = {}): JobItem => ({
  kind: 'job',
  id,
  at: 1000,
  request: 'Check',
  state: 'working',
  ...over,
})

/** A pusher over a real state file with one phone, a clock and a sender the test controls. */
async function fixture(
  options: { activities?: Record<string, string>; configured?: boolean } = {},
) {
  const dir = await temp()
  const path = join(dir, 'phone.json')
  const P = generateKeyPair()
  await updateState(path, (state) => {
    state.devices.push({
      id: deviceId(P.pub),
      name: 'iPhone',
      key: b64u(P.pub),
      tokenHash: 'x',
      addedAt: 1,
      push: { token: 'ab12', env: 'sandbox' },
      ...(options.activities && { activities: options.activities }),
    })
    state.devices.push({
      id: 'other',
      name: 'iPad',
      key: b64u(generateKeyPair().pub),
      tokenHash: 'y',
      addedAt: 1,
    })
  })
  const sent: ApnsRequest[] = []
  const clock = { now: 5_000_000 }
  const wakes: number[] = []
  const notices: string[] = []
  const reply: { next: ApnsResult } = { next: { status: 200 } }
  const pusher = () =>
    new Pusher({
      instance: () => 'inst1',
      now: () => clock.now,
      apns: async () =>
        options.configured === false
          ? undefined
          : {
              send: async (request) => {
                sent.push(request)
                return reply.next
              },
              topic: 'app.test',
            },
      state: { read: () => loadState(path), update: (modify) => updateState(path, modify) },
      schedule: (at) => void wakes.push(at),
      notice: (message) => void notices.push(message),
    })
  const state = () => loadState(path)
  const decrypt = async (enc: string) => {
    const kPush = pushKey(macKeys(await state()), P.pub)
    const bytes = Buffer.from(enc, 'base64url')
    const decipher = createDecipheriv('chacha20-poly1305', kPush, bytes.subarray(0, 12), {
      authTagLength: 16,
    })
    decipher.setAAD(Buffer.from('ultimate-push/1'), { plaintextLength: bytes.length - 28 })
    decipher.setAuthTag(bytes.subarray(bytes.length - 16))
    return JSON.parse(
      Buffer.concat([
        decipher.update(bytes.subarray(12, bytes.length - 16)),
        decipher.final(),
      ]).toString(),
    )
  }
  return { pusher, sent, clock, wakes, notices, reply, state, decrypt, P }
}

it('alerts a phone once per answered job, with the summary sealed for it', async () => {
  const f = await fixture()
  const pusher = f.pusher()
  await pusher.observe([job(42)])
  expect(f.sent).toEqual([])
  const answered = job(42, {
    state: 'answered',
    speech: 'Done. The tests pass.',
    summary: 'Tests pass.',
    detail: 'All green.',
  })
  await pusher.observe([answered])
  await pusher.observe([answered])
  expect(f.sent).toHaveLength(1)
  const [alert] = f.sent
  expect(alert).toMatchObject({
    token: 'ab12',
    env: 'sandbox',
    type: 'alert',
    topic: 'app.test',
    priority: 10,
  })
  const { u, aps } = alert.payload as {
    u: { instance: string; job: number; enc: string }
    aps: object
  }
  expect(aps).toEqual({
    alert: { title: 'Ultimate', body: '@ultimate answered' },
    'mutable-content': 1,
    sound: 'default',
    'thread-id': 'inst1',
    category: 'ANSWER',
  })
  expect({ ...u, enc: undefined }).toEqual({ instance: 'inst1', job: 42, enc: undefined })
  expect(await f.decrypt(u.enc)).toEqual({ title: 'Ultimate', body: 'Tests pass.', job: 42 })
  // Another process of this Mac, watching the same job, finds the alert already claimed in the state file.
  const other = f.pusher()
  await other.observe([job(42)])
  await other.observe([answered])
  expect(f.sent).toHaveLength(1)
  expect((await f.state()).devices[0].alerted).toEqual(['inst1:42'])
})

it('does not alert for jobs that concluded before it started', async () => {
  const f = await fixture()
  const pusher = f.pusher()
  await pusher.observe([
    job(1, { state: 'answered', speech: 'Hi', detail: 'x' }),
    job(2, { state: 'failed', summary: 'Stopped.' }),
    job(3),
  ])
  await pusher.observe([
    job(1, { state: 'answered', speech: 'Hi', detail: 'x' }),
    job(2, { state: 'failed', summary: 'Stopped.' }),
    job(3, { state: 'answered', speech: 'Three.', summary: 'Three.' }),
  ])
  expect(f.sent.map((r) => (r.payload as { u: { job: number } }).u.job)).toEqual([3])
})

it('announces an answer Voice never spoke after 20 seconds, by its first sentence', async () => {
  const f = await fixture()
  const pusher = f.pusher()
  const long = `${'Everything passes '.repeat(12)}and more. Second sentence.`
  await pusher.observe([job(7)])
  const answered = job(7, { state: 'answered', detail: `Tests pass in 3 s. ${long}` })
  await pusher.observe([answered])
  expect(f.sent).toEqual([])
  expect(f.wakes.at(-1)).toBe(f.clock.now + ANSWER_WAIT)
  f.clock.now += ANSWER_WAIT
  await pusher.observe([answered])
  expect(await f.decrypt((f.sent[0].payload as { u: { enc: string } }).u.enc)).toMatchObject({
    body: 'Tests pass in 3 s.',
    job: 7,
  })
  expect(summaryOf(long).length).toBe(140)
  expect(summaryOf(long).endsWith('…')).toBe(true)
})

it('alerts a failed job at once', async () => {
  const f = await fixture()
  const pusher = f.pusher()
  await pusher.observe([job(9)])
  await pusher.observe([
    job(9, { state: 'failed', summary: 'Ultimate was stopped before it answered.' }),
  ])
  expect(f.sent).toHaveLength(1)
  const { u, aps } = f.sent[0].payload as { u: { enc: string }; aps: { alert: { body: string } } }
  expect(aps.alert.body).toBe('@ultimate failed')
  expect(await f.decrypt(u.enc)).toEqual({
    title: 'Ultimate',
    body: 'Ultimate was stopped before it answered.',
    job: 9,
  })
})

it('updates a Live Activity at most every 10 seconds, ends it with the summary and forgets its token', async () => {
  const f = await fixture({ activities: { 5: 'la-token' } })
  const pusher = f.pusher()
  await pusher.observe([job(5, { phase: 'Thinking' })])
  expect(f.sent).toHaveLength(1)
  expect(f.sent[0]).toMatchObject({
    token: 'la-token',
    env: 'sandbox',
    type: 'liveactivity',
    topic: 'app.test.push-type.liveactivity',
  })
  expect((f.sent[0].payload as { aps: object }).aps).toEqual({
    timestamp: Math.floor(f.clock.now / 1000),
    event: 'update',
    'content-state': { state: 'working', phase: 'Thinking', since: 1000 },
  })
  // The same phase sends nothing; a new one inside the window waits for it.
  f.clock.now += 3000
  await pusher.observe([job(5, { phase: 'Thinking' })])
  await pusher.observe([job(5, { phase: 'Running a command' })])
  expect(f.sent).toHaveLength(1)
  expect(f.wakes.at(-1)).toBe(f.clock.now - 3000 + ACTIVITY_EVERY)
  f.clock.now += ACTIVITY_EVERY
  await pusher.observe([job(5, { phase: 'Running a command' })])
  expect(f.sent).toHaveLength(2)
  // The end is not held, and carries the summary.
  f.clock.now += 1000
  await pusher.observe([job(5, { state: 'answered', speech: 'Done.', summary: 'Tests pass.' })])
  const end = f.sent.filter((r) => r.type === 'liveactivity').at(-1)!
  expect((end.payload as { aps: { event: string; 'content-state': object } }).aps).toMatchObject({
    event: 'end',
    'content-state': { state: 'answered', since: 1000, summary: 'Tests pass.' },
  })
  expect(end.priority).toBe(10)
  expect((await f.state()).devices[0].activities).toEqual({})
})

it('drops a push token APNs says is dead', async () => {
  const f = await fixture({ activities: { 5: 'la-token' } })
  const pusher = f.pusher()
  f.reply.next = { status: 410, reason: 'Unregistered' }
  await pusher.observe([job(5)])
  expect((await f.state()).devices[0].activities).toEqual({})
  await pusher.observe([job(6)])
  f.reply.next = { status: 400, reason: 'BadDeviceToken' }
  await pusher.observe([job(6, { state: 'answered', speech: 'Hi', summary: 'Hi' })])
  expect((await f.state()).devices[0].push).toBeUndefined()
  f.reply.next = { status: 500, reason: 'InternalServerError' }
  await pusher.observe([job(8)])
  expect(f.notices).toEqual([])
})

it('skips pushes while APNs is not configured, and does not alert for those jobs later', async () => {
  const f = await fixture({ configured: false })
  const pusher = f.pusher()
  await pusher.observe([job(1)])
  await pusher.observe([job(1, { state: 'answered', speech: 'Hi', summary: 'Hi' })])
  expect(f.sent).toEqual([])
  expect((await f.state()).devices[0].alerted).toBeUndefined()
})

/** The phone service on a Mac with a relay, APNs settings and key, over in-memory Voice. */
async function service() {
  const userHome = await temp()
  const projectRoot = await temp('project-')
  await writeSecret(userHome, 'ULTIMATE_PHONE_RELAY_TOKEN', 'relay-secret')
  const sent: ApnsRequest[] = []
  const configs: unknown[] = []
  const source = new FakeSource()
  const socket = (): RelaySocket => ({
    send: () => {},
    close: () => {},
    addEventListener: (type: string, listener: (event: never) => void) => {
      if (type === 'open') queueMicrotask(() => (listener as () => void)())
    },
  })
  const phone = createPhone(
    {
      userHome,
      projectRoot,
      home: join(userHome, 'preview'),
      projects: async () => [],
      notice: () => {},
    },
    {
      voice: fakeVoice().voice,
      source,
      env: { ULTIMATE_PHONE_RELAY: 'wss://relay.test' },
      connect: socket,
      apns: (config) => {
        configs.push(config)
        return { send: async (r) => (sent.push(r), { status: 200 }), close: () => {} }
      },
    },
  )
  await phone.start()
  return { phone, userHome, projectRoot, sent, configs, source }
}

it('says whether push is configured, and what is missing', async () => {
  const f = await service()
  expect((await f.phone.status()).push).toEqual({
    configured: false,
    error: expect.stringContaining('"apns"'),
  })
  await mkdir(join(f.userHome, '.ultimate'), { recursive: true })
  await writeFile(
    join(f.userHome, '.ultimate/settings.json'),
    JSON.stringify({ phone: { apns: { keyId: 'K', teamId: 'T', topic: 'app.test' } } }),
  )
  expect((await f.phone.status()).push).toEqual({
    configured: false,
    error: expect.stringContaining('APNS_AUTH_KEY'),
  })
  await writeSecret(f.userHome, 'APNS_AUTH_KEY', 'pem')
  expect((await f.phone.status()).push).toEqual({ configured: true })
  expect(f.configs).toEqual([{ keyId: 'K', teamId: 'T', key: 'pem' }])
  f.phone.stop()
})

it('alerts the phones from the Voice transcript once the settings and key are in', async () => {
  const f = await service()
  await until(async () => (await f.phone.status()).state === 'online')
  await mkdir(join(f.userHome, '.ultimate'), { recursive: true })
  await writeFile(
    join(f.userHome, '.ultimate/settings.json'),
    JSON.stringify({ phone: { apns: { keyId: 'K', teamId: 'T', topic: 'app.test' } } }),
  )
  await writeSecret(f.userHome, 'APNS_AUTH_KEY', 'pem')
  const state = await loadState(join(f.userHome, '.ultimate/phone.json'))
  const P = generateKeyPair()
  await updateState(join(f.userHome, '.ultimate/phone.json'), (s) => {
    s.devices.push({
      id: deviceId(P.pub),
      name: 'iPhone',
      key: b64u(P.pub),
      tokenHash: 'x',
      addedAt: 1,
      push: { token: 'ab12', env: 'production' },
    })
  })
  const line = f.source.add('voice.line', { role: 'user', forwarded: true, text: 'Check', at: 1 })
  await until(() => f.source.watchers > 0)
  await f.phone.services.feed.join(10, () => {})
  f.source.add('voice.answer', { text: 'Tests pass. All good.', re: line })
  f.source.add('voice.line', {
    role: 'ultimate',
    speech: true,
    text: 'Tests pass.',
    re: line,
    summary: 'Tests pass.',
  })
  await until(() => f.sent.length > 0)
  expect(f.sent[0]).toMatchObject({
    token: 'ab12',
    env: 'production',
    type: 'alert',
    topic: 'app.test',
  })
  expect((f.sent[0].payload as { u: { instance: string } }).u.instance).toBe(
    instanceId(Buffer.from(state.machineSecret, 'base64url'), f.projectRoot),
  )
  f.phone.stop()
})
