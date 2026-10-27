/** One instance's phone service: resolves the configuration, runs the relay connection and pairing, answers the actions. */
// oxlint-disable-next-line no-restricted-imports -- like tailscale, "temporary" means a home that is not the project's own default
import { projectHome } from '../../server/project.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { readJson } from '../../lib/json-file.ts'
import { readSecret } from '../../lib/secrets.ts'
import { readSettings, userSettingsPath } from '../../lib/settings.ts'
import type { VoiceLiveService } from '../voice-live/api.ts'
import { createApns } from './apns.ts'
import type { Apns, ApnsConfig } from './apns.ts'
import { UNAUTHORIZED } from './channel.ts'
import { Connector } from './connector.ts'
import type { Connect } from './connector.ts'
import { instanceId, pairingQr, randomToken, tokenHash } from './crypto.ts'
import { createFeed } from './feed.ts'
import type { FeedSource } from './feed.ts'
import { Pairing } from './pairing.ts'
import { Pusher } from './push.ts'
import type { Services } from './methods.ts'
import type { PhoneStatus } from './refs.ts'
import { loadState, statePath, updateState } from './state.ts'
import type { PhoneState } from './state.ts'

type PhoneHost = Pick<ExtensionHost, 'userHome' | 'projectRoot' | 'home' | 'projects' | 'notice'>
export type PhoneDeps = {
  /** Voice, which `say` talks into and whose transcript the feed follows. */
  voice: VoiceLiveService
  source: FeedSource
  /** The APNs client for a configuration; tests give one that sends nothing. */
  apns?: (config: ApnsConfig) => Apns
  env?: NodeJS.ProcessEnv
  connect?: Connect
  fetch?: typeof fetch
}

const defaultConnect: Connect = (url, headers) =>
  // Node's WebSocket (undici) takes request headers as a second argument; its types do not know them.
  new (WebSocket as unknown as new (
    url: string,
    options: { headers: Record<string, string> },
  ) => ReturnType<Connect>)(url, { headers })

type Setup = { relay: string; token: string }

export function createPhone(host: PhoneHost, deps: PhoneDeps) {
  const env = deps.env ?? process.env
  const path = statePath(host.userHome, env)
  // Only the project's own server (on its default home) goes online; a preview or scratch home stays off unless asked.
  const temporary = host.home !== projectHome(host.projectRoot, host.userHome)
  let connector: Connector | undefined
  let instance: string | undefined
  let relay: string | undefined
  let starting: Promise<void> | undefined
  let stopped = false
  let opened = false
  let apns: { signature: string; client: Apns } | undefined

  const settings = async () => {
    // Invalid user settings are reported by the settings loader; treat them as unset here.
    const user = await readSettings(userSettingsPath(host.userHome)).catch(() => ({}))
    const phone = 'phone' in user ? user.phone : undefined
    return (phone && typeof phone === 'object' && !Array.isArray(phone) ? phone : {}) as {
      relay?: unknown
      apns?: { keyId?: unknown; teamId?: unknown; topic?: unknown }
      elevenlabs?: { voice?: string; model?: string }
    }
  }
  const pairing = new Pairing({
    publish: (hash, expires) => connector?.send({ t: 'pairing', token: hash, expires }),
    async complete({ device, name, key }) {
      const deviceToken = randomToken()
      await updateState(path, (state) => {
        const known = state.devices.find((entry) => entry.id === device)
        state.devices = state.devices.filter((entry) => entry.id !== device)
        state.devices.push({
          ...known,
          id: device,
          name,
          key: key.toString('base64url'),
          tokenHash: tokenHash(deviceToken),
          addedAt: Date.now(),
        })
      })
      await connector?.sendDevices()
      return { deviceToken }
    },
  })
  const feed = createFeed(deps.source, { notice: (message) => host.notice(message) })
  const pusher = new Pusher({
    instance: () => instance!,
    now: Date.now,
    apns: async () => {
      const setup = await pushSetup()
      return 'missing' in setup ? undefined : setup
    },
    state: { read: () => loadState(path), update: (modify) => updateState(path, modify) },
    schedule: feed.wake,
    notice: (message) => host.notice(message),
  })
  feed.observe((items) => pusher.observe(items))
  const services: Services = {
    get instance() {
      return instance!
    },
    host,
    pairing,
    state: () => loadState(path),
    update: (modify) => updateState(path, modify),
    settings,
    secret: (name) => readSecret(host.userHome, name),
    fetch: deps.fetch ?? fetch,
    voice: deps.voice,
    feed,
  }

  /** The APNs sender and topic, or what is missing for push. */
  async function pushSetup(): Promise<{ missing: string } | { send: Apns['send']; topic: string }> {
    const { apns: configured } = await settings()
    const { keyId, teamId, topic } = configured ?? {}
    if (
      typeof keyId !== 'string' ||
      typeof teamId !== 'string' ||
      typeof topic !== 'string' ||
      !keyId ||
      !teamId ||
      !topic
    )
      return {
        missing:
          'Set "phone": { "apns": { "keyId", "teamId", "topic" } } in ~/.ultimate/settings.json',
      }
    const key = await readSecret(host.userHome, 'APNS_AUTH_KEY')
    if (!key) return { missing: 'Add APNS_AUTH_KEY in the Secrets panel (⌘K → Secrets)' }
    const signature = JSON.stringify([keyId, teamId, key])
    if (apns?.signature !== signature) {
      apns?.client.close()
      apns = { signature, client: (deps.apns ?? createApns)({ keyId, teamId, key }) }
    }
    return { send: apns.client.send, topic }
  }
  const pushStatus = async (): Promise<PhoneStatus['push']> => {
    const setup = await pushSetup()
    return 'missing' in setup ? { configured: false, error: setup.missing } : { configured: true }
  }

  /** What is missing for the relay, or the relay and its token. */
  async function configuration(): Promise<
    Setup | { off: true } | { missing: string; kind: 'relay' | 'token' }
  > {
    if (!env.ULTIMATE_PHONE_RELAY && temporary) return { off: true }
    const configured = env.ULTIMATE_PHONE_RELAY || (await settings()).relay
    if (typeof configured !== 'string' || !configured)
      return {
        missing: 'Set "phone": { "relay": "wss://…" } in ~/.ultimate/settings.json',
        kind: 'relay',
      }
    if (!/^wss?:\/\/[^/\s]/.test(configured))
      return { missing: 'phone.relay must be a ws:// or wss:// URL', kind: 'relay' }
    const token =
      env.ULTIMATE_PHONE_RELAY_TOKEN ||
      (await readSecret(host.userHome, 'ULTIMATE_PHONE_RELAY_TOKEN'))
    if (!token)
      return {
        missing: 'Add ULTIMATE_PHONE_RELAY_TOKEN in the Secrets panel (⌘K → Secrets)',
        kind: 'token',
      }
    return { relay: configured, token }
  }

  /** Connect when the configuration is complete and not yet connected. */
  function ensure() {
    starting ??= (async () => {
      if (connector || stopped) return
      const setup = await configuration()
      if (!('token' in setup)) return
      const state = await loadState(path)
      instance = instanceId(Buffer.from(state.machineSecret, 'base64url'), host.projectRoot)
      relay = setup.relay
      connector = new Connector({
        ...setup,
        machine: state.machine,
        instance,
        services,
        connect: deps.connect ?? defaultConnect,
        opened() {
          connector!.sendDevices().catch((error: unknown) => host.notice(`Phone: ${String(error)}`))
          pairing.republish()
        },
      })
      connector.start()
      follow()
    })().finally(() => (starting = undefined))
    return starting
  }

  /** Follow Voice and @ultimate for the feed and pushes: while the connector exists and the harness is open. */
  function follow() {
    if (opened && connector) feed.start()
  }

  const pairingStatus = (state: PhoneState): PhoneStatus['pairing'] => {
    const pending = pairing.pending
    return (
      pending && {
        qr: pairingQr({
          v: 1,
          relay: relay!,
          machine: state.machine,
          instance: instance!,
          key: state.keys.public,
          token: pending.token,
          name: state.name,
        }),
        expires: pending.expires,
        ...(pending.request && { request: pending.request }),
      }
    )
  }

  async function status(): Promise<PhoneStatus> {
    try {
      await ensure()
      if (!connector) {
        const setup = await configuration()
        const state = await readJson<PhoneState | undefined>(path, undefined)
        const base = {
          instance: state
            ? instanceId(Buffer.from(state.machineSecret, 'base64url'), host.projectRoot)
            : '',
          devices: state ? devices(state) : [],
          ...(state && { name: state.name }),
        }
        const push = await pushStatus()
        if ('missing' in setup)
          return {
            state: 'unconfigured',
            error: setup.missing,
            missing: setup.kind,
            push,
            ...base,
          }
        return { state: 'off', push, ...base }
      }
      const state = await loadState(path)
      const shown = pairingStatus(state)
      return {
        state: connector.state,
        ...(connector.error && { error: connector.error }),
        relay,
        instance: instance!,
        name: state.name,
        devices: devices(state),
        push: await pushStatus(),
        ...(shown && { pairing: shown }),
      }
    } catch (error) {
      return {
        state: 'error',
        error: error instanceof Error ? error.message : String(error),
        instance: instance ?? '',
        devices: [],
      }
    }
  }

  const devices = (state: PhoneState): PhoneStatus['devices'] =>
    state.devices.map((device) => ({
      id: device.id,
      name: device.name,
      addedAt: device.addedAt,
      ...(device.lastSeen && { lastSeen: device.lastSeen }),
      push: device.push !== undefined,
    }))

  async function online() {
    await ensure()
    if (!connector) {
      const setup = await configuration()
      throw new Error('missing' in setup ? setup.missing : 'Phone is off on this instance')
    }
    return connector
  }

  return {
    services,
    status,
    /** The harness opened: connect if configured and follow the transcript. */
    start: async () => {
      opened = true
      await ensure()
      follow()
    },
    /** The harness is going away (a core swap); `start` follows again when the next one opens. */
    release() {
      opened = false
      feed.stop()
    },
    stop() {
      stopped = true
      opened = false
      feed.stop()
      apns?.client.close()
      pairing.cancel()
      connector?.stop()
      connector = undefined
    },
    async pairStart() {
      await online()
      pairing.start()
      const { qr, expires } = pairingStatus(await loadState(path))!
      return { qr, expires }
    },
    async pairCancel() {
      pairing.cancel()
      return status()
    },
    async pairAllow(device: string) {
      await pairing.allow(device)
      return status()
    },
    async pairDeny(device: string) {
      pairing.deny(device)
      return status()
    },
    async revoke(device: string) {
      const live = await online()
      let found = false
      await updateState(path, (state) => {
        found = state.devices.some((entry) => entry.id === device)
        state.devices = state.devices.filter((entry) => entry.id !== device)
      })
      if (!found) throw new Error('That phone is not paired')
      await live.sendDevices()
      live.closeDevice(device, UNAUTHORIZED)
      return status()
    },
  }
}
