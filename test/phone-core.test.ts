import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { writeSecret } from '../extensions/secrets/store.ts'
import { createPhone } from '../extensions/phone/runtime.ts'
import { updateState } from '../extensions/phone/state.ts'
import type { RelaySocket } from '../extensions/phone/connector.ts'
import {
  b64u,
  deviceId,
  generateKeyPair,
  instanceId,
  open,
  parsePairingQr,
  phoneSession,
  seal,
  tokenHash,
} from '../extensions/phone/crypto.ts'
import type { KeyPair } from '../extensions/phone/crypto.ts'
import { pairingQr } from '../extensions/phone/code.ts'
import type { PhoneStatus } from '../extensions/phone/refs.ts'
import type { PhoneState } from '../extensions/phone/state.ts'
import { temp, until } from './helpers.ts'
import { FakeSource, fakeVoice } from './phone-fakes.ts'

/** The code a pairing shows, as the browser makes the QR text from it. */
async function pairingCode(phone: { status(): Promise<PhoneStatus> }) {
  const { expires: _expires, request: _request, ...code } = (await phone.status()).pairing!
  return parsePairingQr(pairingQr(code))
}

type Out = {
  t: string
  conn?: string
  code?: number
  data?: string
  tokens?: string[]
  token?: string
  expires?: number
}

/** A relay in memory: the Mac's socket, what it sent, and phone sockets that exist only as conn ids. */
function fakeRelay() {
  const out: Out[] = []
  const urls: { url: string; headers: Record<string, string> }[] = []
  const listeners = new Map<string, (event: any) => void>()
  const connect = (url: string, headers: Record<string, string>): RelaySocket => {
    urls.push({ url, headers })
    queueMicrotask(() => listeners.get('open')?.({}))
    return {
      send: (data) => void out.push(JSON.parse(data)),
      close: () => {},
      addEventListener: (type: string, listener: (event: any) => void) =>
        void listeners.set(type, listener),
    }
  }
  const toMac = (message: object) => listeners.get('message')?.({ data: JSON.stringify(message) })
  return { out, urls, connect, toMac }
}
type Relay = ReturnType<typeof fakeRelay>

/** The phone's side of a conn: handshake and sealed frames, with counters it can break. */
class FakePhone {
  P: KeyPair
  relay: Relay
  conn: string
  session?: ReturnType<typeof phoneSession>
  sent = 0
  seen = 0
  messages: Record<string, any>[] = []
  constructor(relay: Relay, conn: string, P = generateKeyPair()) {
    this.relay = relay
    this.conn = conn
    this.P = P
  }
  get device() {
    return deviceId(this.P.pub)
  }
  raw(frame: Buffer) {
    this.relay.toMac({ t: 'data', conn: this.conn, data: frame.toString('base64') })
  }
  closed() {
    return this.relay.out.find((m) => m.t === 'close' && m.conn === this.conn)
  }
  frames() {
    return this.relay.out.filter((m) => m.t === 'data' && m.conn === this.conn)
  }
  async connect(mPub: Buffer) {
    this.relay.toMac({ t: 'open', conn: this.conn })
    const Ep = generateKeyPair()
    this.raw(
      Buffer.from(
        JSON.stringify({ t: 'hello', v: 1, device: b64u(this.P.pub), eph: b64u(Ep.pub) }),
      ),
    )
    await until(() => this.frames().length > 0 || this.closed() !== undefined)
    if (this.closed()) return false
    const welcome = JSON.parse(Buffer.from(this.frames()[0].data!, 'base64').toString())
    const Em = Buffer.from(welcome.eph, 'base64url')
    this.session = phoneSession(this.P, Ep, mPub, Em)
    // The proof opens only with the Mac's keys; opening throws otherwise.
    open(this.session.kMP, Buffer.from(welcome.proof, 'base64url'), this.session.h)
    this.seen = 1
    return true
  }
  frame(message: object, counter = this.sent++) {
    return seal(this.session!.kPM, counter, Buffer.from(JSON.stringify(message)), this.session!.h)
  }
  send(message: object) {
    this.raw(this.frame(message))
  }
  /** Calls a method and waits for the answer with the same id. */
  async call(id: number, method: string, params: object = {}) {
    this.send({ id, method, params })
    await until(() => this.drain().some((m) => m.id === id) || this.closed() !== undefined)
    return this.messages.find((m) => m.id === id)!
  }
  drain() {
    const frames = this.frames()
    while (this.session && this.seen < frames.length) {
      const frame = Buffer.from(frames[this.seen++].data!, 'base64')
      this.messages.push(JSON.parse(open(this.session.kMP, frame, this.session.h).toString()))
    }
    return this.messages
  }
}

/** `userHome` shares the state file with another fixture, like two projects' processes. */
async function fixture(configure = true, extraEnv: NodeJS.ProcessEnv = {}, sharedHome?: string) {
  const userHome = sharedHome ?? (await temp())
  const projectRoot = await temp('project-')
  const relay = fakeRelay()
  const projects = async () => [
    { name: 'ultimate', root: projectRoot, current: true, home: '', conversations: [] },
    {
      name: 'other',
      root: '/Users/me/Code/other',
      running: { pid: 1, url: 'x' },
      current: false,
      home: '',
      conversations: [],
    },
    { name: 'gone', root: '/Users/me/Code/gone', current: false, home: '', conversations: [] },
    { name: 'no root', current: false, home: '', conversations: [] },
  ]
  if (configure) await writeSecret(userHome, 'ULTIMATE_PHONE_RELAY_TOKEN', 'relay-secret')
  const { voice, calls } = fakeVoice()
  const source = new FakeSource()
  const phone = createPhone(
    { userHome, projectRoot, home: join(userHome, 'preview'), projects, notice: () => {} },
    {
      voice,
      source,
      env: configure ? { ULTIMATE_PHONE_RELAY: 'wss://relay.test', ...extraEnv } : {},
      connect: relay.connect,
    },
  )
  await phone.start()
  const statePath = join(userHome, '.ultimate/phone.json')
  const state = async () => JSON.parse(await readFile(statePath, 'utf8')) as PhoneState
  return { phone, relay, userHome, projectRoot, statePath, state, calls, source }
}

it('stays inert without configuration and says what is missing', async () => {
  const { phone, relay, statePath } = await fixture(false)
  expect(await phone.status()).toMatchObject({ state: 'off', devices: [] })
  expect(relay.urls).toEqual([])
  await expect(stat(statePath)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(phone.pairStart()).rejects.toThrow('Phone is off')
})

it('says which secret is missing', async () => {
  const userHome = await temp()
  const phone = createPhone(
    { userHome, projectRoot: '/p', home: '/x', projects: async () => [], notice: () => {} },
    {
      voice: fakeVoice().voice,
      source: new FakeSource(),
      env: { ULTIMATE_PHONE_RELAY: 'wss://relay.test' },
    },
  )
  expect(await phone.status()).toMatchObject({
    state: 'unconfigured',
    error: expect.stringContaining('ULTIMATE_PHONE_RELAY_TOKEN'),
    missing: 'token',
  })
  const badRelay = createPhone(
    { userHome, projectRoot: '/p', home: '/x', projects: async () => [], notice: () => {} },
    { voice: fakeVoice().voice, source: new FakeSource(), env: { ULTIMATE_PHONE_RELAY: 'nope' } },
  )
  expect(await badRelay.status()).toMatchObject({ state: 'unconfigured', missing: 'relay' })
})

it('takes the relay token from the environment before the secret', async () => {
  const { relay, phone } = await fixture(true, { ULTIMATE_PHONE_RELAY_TOKEN: 'env-token' })
  await until(async () => (await phone.status()).state === 'online')
  expect(relay.urls[0].headers).toEqual({ Authorization: 'Bearer env-token' })
  phone.stop()
})

it('pairs a phone, serves it as a known device, and cuts it off when revoked', async () => {
  const { phone, relay, projectRoot, statePath, state } = await fixture()
  await until(async () => (await phone.status()).state === 'online')
  const initial = await state()
  const mPub = Buffer.from(initial.keys.public, 'base64url')
  const instance = instanceId(Buffer.from(initial.machineSecret, 'base64url'), projectRoot)

  // The connector authenticates with the relay token and announces the (empty) device set.
  expect(relay.urls[0]).toEqual({
    url: `wss://relay.test/v1/m/${initial.machine}/mac?instance=${instance}`,
    headers: { Authorization: 'Bearer relay-secret' },
  })
  expect(relay.out[0]).toEqual({ t: 'devices', tokens: [] })
  expect((await stat(statePath)).mode & 0o777).toBe(0o600)

  // An unknown phone with no pairing pending is refused.
  const stranger = new FakePhone(relay, 'stranger')
  expect(await stranger.connect(mPub)).toBe(false)
  expect(stranger.closed()?.code).toBe(4401)

  // pairStart: a code for this instance, announced to the relay.
  const { expires } = await phone.pairStart()
  const code = await pairingCode(phone)
  expect(code).toMatchObject({
    v: 1,
    relay: 'wss://relay.test',
    machine: initial.machine,
    instance,
    key: initial.keys.public,
  })
  expect(relay.out.filter((m) => m.t === 'pairing').at(-1)).toEqual({
    t: 'pairing',
    token: tokenHash(code.token),
    expires,
  })

  // pair waits for the user.
  const iphone = new FakePhone(relay, 'c1')
  expect(await iphone.connect(mPub)).toBe(true)
  iphone.send({ id: 1, method: 'pair', params: { token: code.token, name: "Sam's iPhone" } })
  await until(async () => (await phone.status()).pairing?.request !== undefined)
  expect((await phone.status()).pairing?.request).toEqual({
    device: iphone.device,
    name: "Sam's iPhone",
  })
  expect(iphone.drain()).toEqual([])
  await phone.pairAllow(iphone.device)
  await until(() => iphone.drain().some((m) => m.id === 1))
  const answer = iphone.messages[0].result
  expect(answer).toMatchObject({ machine: initial.machine, name: initial.name })

  // The device is stored, its token hash given to the relay, the pairing token withdrawn.
  const paired = await state()
  expect(paired.devices).toMatchObject([
    { id: iphone.device, name: "Sam's iPhone", tokenHash: tokenHash(answer.deviceToken) },
  ])
  expect(relay.out.filter((m) => m.t === 'devices').at(-1)).toEqual({
    t: 'devices',
    tokens: [tokenHash(answer.deviceToken)],
  })
  expect(relay.out.filter((m) => m.t === 'pairing').at(-1)).toEqual({
    t: 'pairing',
    token: tokenHash(code.token),
    expires: 0,
  })
  expect((await phone.status()).pairing).toBeUndefined()

  // It comes back as a known device, on a new conn.
  const again = new FakePhone(relay, 'c2', iphone.P)
  expect(await again.connect(mPub)).toBe(true)
  expect((await again.call(1, 'ping')).result).toEqual({})
  const { instances } = (await again.call(2, 'instances')).result
  expect(instances).toEqual([
    { id: instance, name: 'ultimate', running: true, current: true },
    {
      id: instanceId(Buffer.from(paired.machineSecret, 'base64url'), '/Users/me/Code/other'),
      name: 'other',
      running: true,
      current: false,
    },
    {
      id: instanceId(Buffer.from(paired.machineSecret, 'base64url'), '/Users/me/Code/gone'),
      name: 'gone',
      running: false,
      current: false,
    },
  ])
  expect((await again.call(3, 'push.register', { token: 'ab12', env: 'sandbox' })).result).toEqual(
    {},
  )
  expect((await again.call(4, 'activity.register', { job: 42, token: 'cd34' })).result).toEqual({})
  expect((await state()).devices[0]).toMatchObject({
    push: { token: 'ab12', env: 'sandbox' },
    activities: { [`${instance}:42`]: 'cd34' },
  })
  expect((await phone.status()).devices).toMatchObject([{ id: iphone.device, push: true }])
  expect((await phone.status()).name).toBe(initial.name)
  // lastSeen is set when a known device handshakes, and not again within a minute.
  await until(async () => (await state()).devices[0].lastSeen !== undefined)
  const seen = (await state()).devices[0].lastSeen
  expect(seen).toBeGreaterThan(Date.now() - 60000)
  await again.call(5, 'ping')
  expect((await state()).devices[0].lastSeen).toBe(seen)

  // A replayed frame and a skipped counter end the conn with 4400.
  const replay = again.frame({ id: 9, method: 'ping', params: {} }, 0)
  again.raw(replay)
  await until(() => again.closed() !== undefined)
  expect(again.closed()?.code).toBe(4400)
  const skipping = new FakePhone(relay, 'c3', iphone.P)
  await skipping.connect(mPub)
  skipping.raw(skipping.frame({ id: 1, method: 'ping', params: {} }, 5))
  await until(() => skipping.closed() !== undefined)
  expect(skipping.closed()?.code).toBe(4400)

  // Revoking removes the device, updates the relay and closes its open conn.
  const open1 = new FakePhone(relay, 'c4', iphone.P)
  await open1.connect(mPub)
  await phone.revoke(iphone.device)
  expect((await state()).devices).toEqual([])
  expect(relay.out.filter((m) => m.t === 'devices').at(-1)).toEqual({ t: 'devices', tokens: [] })
  expect(open1.closed()?.code).toBe(4401)
  const late = new FakePhone(relay, 'c5', iphone.P)
  expect(await late.connect(mPub)).toBe(false)
  phone.stop()
})

it('answers "Pairing was declined" when the user denies', async () => {
  const { phone, relay, state } = await fixture()
  await until(async () => (await phone.status()).state === 'online')
  const mPub = Buffer.from((await state()).keys.public, 'base64url')
  await phone.pairStart()
  const iphone = new FakePhone(relay, 'c1')
  await iphone.connect(mPub)
  iphone.send({
    id: 1,
    method: 'pair',
    params: { token: (await pairingCode(phone)).token, name: 'iPhone' },
  })
  await until(async () => (await phone.status()).pairing?.request !== undefined)
  await phone.pairDeny(iphone.device)
  await until(() => iphone.drain().some((m) => m.id === 1))
  expect(iphone.messages[0].error).toEqual({ message: 'Pairing was declined' })
  expect((await state()).devices).toEqual([])
  // The relay closes a pairing phone's socket when the code is withdrawn, so the answer goes first.
  await until(() => relay.out.filter((m) => m.t === 'pairing').at(-1)?.expires === 0)
  const answer = relay.out.findLastIndex((m) => m.t === 'data' && m.conn === 'c1')
  const withdrawn = relay.out.findLastIndex((m) => m.t === 'pairing')
  expect(answer).toBeLessThan(withdrawn)
  phone.stop()
})

it('serves say and the feed to a paired phone, and stops the events when its conn goes', async () => {
  const { phone, relay, state, statePath, calls, source } = await fixture()
  await until(async () => (await phone.status()).state === 'online')
  const mPub = Buffer.from((await state()).keys.public, 'base64url')
  const P = generateKeyPair()
  await updateState(statePath, (s) => {
    s.devices.push({
      id: deviceId(P.pub),
      name: 'iPhone',
      key: b64u(P.pub),
      tokenHash: 'x',
      addedAt: 1,
    })
  })
  for (const text of ['one', 'two', 'three']) source.add('voice.heard', { text }, Date.now())
  const iphone = new FakePhone(relay, 'c1', P)
  expect(await iphone.connect(mPub)).toBe(true)

  expect((await iphone.call(1, 'say', { id: 'u1', text: 'hello', via: 'voice' })).result).toEqual(
    {},
  )
  await iphone.call(2, 'say', { id: 'u1', text: 'hello', via: 'voice' })
  expect(calls.open).toHaveLength(1)
  expect(calls.heard).toEqual([
    ['hello', 'u1'],
    ['hello', 'u1'],
  ])
  expect((await iphone.call(3, 'say', { id: 'u2', text: 'x' })).error).toEqual({
    message: 'via must be "voice" or "text"',
  })

  const snapshot = (await iphone.call(4, 'feed.subscribe', { limit: 2 })).result.items
  expect(snapshot.map((item: { text: string }) => item.text)).toEqual(['two', 'three'])
  source.add('voice.heard', { text: 'four' }, Date.now())
  await until(() => iphone.drain().some((m) => m.event === 'feed'))
  expect(iphone.messages.find((m) => m.event === 'feed')).toMatchObject({
    data: { items: [{ kind: 'heard', text: 'four' }] },
  })
  const events = () => iphone.drain().filter((m) => m.event === 'feed').length
  relay.toMac({ t: 'close', conn: 'c1' })
  source.add('voice.heard', { text: 'five' }, Date.now())
  await phone.status()
  expect(events()).toBe(1)
  phone.stop()
})

/** Adds a paired phone to the state file as pairing would. */
async function addDevice(statePath: string, P: KeyPair) {
  await updateState(statePath, (s) => {
    s.devices.push({
      id: deviceId(P.pub),
      name: 'iPhone',
      key: b64u(P.pub),
      tokenHash: 'x',
      addedAt: 1,
    })
  })
}

it("closes a phone's open feed when another project's process removes it", async () => {
  const a = await fixture()
  const b = await fixture(true, {}, a.userHome)
  await until(async () => (await a.phone.status()).state === 'online')
  await until(async () => (await b.phone.status()).state === 'online')
  const mPub = Buffer.from((await a.state()).keys.public, 'base64url')
  const P = generateKeyPair()
  await addDevice(a.statePath, P)
  const onB = new FakePhone(b.relay, 'c1', P)
  expect(await onB.connect(mPub)).toBe(true)
  await onB.call(1, 'feed.subscribe', { limit: 5 })
  b.source.add('voice.heard', { text: 'one' }, Date.now())
  await until(() => onB.drain().some((m) => m.event === 'feed'))
  expect(onB.closed()).toBeUndefined()

  await a.phone.revoke(deviceId(P.pub))
  b.source.add('voice.heard', { text: 'two' }, Date.now())
  await until(() => onB.closed() !== undefined)
  expect(onB.closed()?.code).toBe(4401)
  expect(onB.drain().filter((m) => m.event === 'feed')).toHaveLength(1)
  a.phone.stop()
  b.phone.stop()
})

it('closes an unknown phone that pairing admitted when it calls anything but pair', async () => {
  const { phone, relay, state } = await fixture()
  await until(async () => (await phone.status()).state === 'online')
  const mPub = Buffer.from((await state()).keys.public, 'base64url')
  await phone.pairStart()
  const stranger = new FakePhone(relay, 'c1')
  expect(await stranger.connect(mPub)).toBe(true)
  stranger.send({ id: 1, method: 'feed.subscribe', params: {} })
  await until(() => stranger.closed() !== undefined)
  expect(stranger.closed()?.code).toBe(4401)
  expect(stranger.drain()).toEqual([])
  phone.stop()
})

it('keeps a feed snapshot inside the protocol frame by cutting details and dropping the oldest jobs', async () => {
  const { phone, relay, state, statePath, source } = await fixture()
  await until(async () => (await phone.status()).state === 'online')
  const mPub = Buffer.from((await state()).keys.public, 'base64url')
  const P = generateKeyPair()
  await addDevice(statePath, P)
  for (let i = 0; i < 100; i++) {
    const line = source.add('voice.line', { role: 'user', text: `q${i}`, forwarded: true }, i + 1)
    source.add('voice.answer', { text: 'x'.repeat(100_000), re: line })
  }
  const iphone = new FakePhone(relay, 'c1', P)
  await iphone.connect(mPub)
  const { result } = await iphone.call(1, 'feed.subscribe', { limit: 200 })
  const items = result.items as { request: string; detail: string }[]
  expect(items.length).toBeGreaterThan(10)
  expect(items.length).toBeLessThan(100)
  expect(items.at(-1)!.request).toBe('q99')
  expect(items.at(-1)!.detail).toHaveLength(16 * 1024 + 1)
  expect(items.at(-1)!.detail.endsWith('…')).toBe(true)
  expect(Buffer.from(iphone.frames().at(-1)!.data!, 'base64').length).toBeLessThanOrEqual(
    1024 * 1024,
  )
  phone.stop()
})

it('does not dispatch names inherited from Object as methods', async () => {
  const { phone, relay, state, statePath } = await fixture()
  await until(async () => (await phone.status()).state === 'online')
  const mPub = Buffer.from((await state()).keys.public, 'base64url')
  const P = generateKeyPair()
  await addDevice(statePath, P)
  const iphone = new FakePhone(relay, 'c1', P)
  await iphone.connect(mPub)
  expect((await iphone.call(1, 'constructor')).error).toEqual({
    message: 'Unknown method constructor',
  })
  expect((await iphone.call(2, 'toString')).error).toEqual({ message: 'Unknown method toString' })
  phone.stop()
})
