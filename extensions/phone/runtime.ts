/** One instance's phone service: resolves the configuration, runs the relay connection and pairing, answers the actions. */
// oxlint-disable-next-line no-restricted-imports -- like tailscale, "temporary" means a home that is not the project's own default
import { projectHome } from '../../server/project.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { readJson } from '../../lib/json-file.ts'
import { readSecret } from '../../lib/secrets.ts'
import { readSettings, userSettingsPath } from '../../lib/settings.ts'
import { UNAUTHORIZED } from './channel.ts'
import { Connector } from './connector.ts'
import type { Connect } from './connector.ts'
import { instanceId, pairingQr, randomToken, tokenHash } from './crypto.ts'
import { Pairing } from './pairing.ts'
import type { Services } from './methods.ts'
import type { PhoneStatus } from './refs.ts'
import { loadState, statePath, updateState } from './state.ts'
import type { PhoneState } from './state.ts'

type PhoneHost = Pick<ExtensionHost, 'userHome' | 'projectRoot' | 'home' | 'projects' | 'notice'>
export type PhoneDeps = {
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

export function createPhone(host: PhoneHost, deps: PhoneDeps = {}) {
  const env = deps.env ?? process.env
  const path = statePath(host.userHome, env)
  // Only the project's own server (on its default home) goes online; a preview or scratch home stays off unless asked.
  const temporary = host.home !== projectHome(host.projectRoot, host.userHome)
  let connector: Connector | undefined
  let instance: string | undefined
  let relay: string | undefined
  let starting: Promise<void> | undefined
  let stopped = false

  const settings = async () => {
    // Invalid user settings are reported by the settings loader; treat them as unset here.
    const user = await readSettings(userSettingsPath(host.userHome)).catch(() => ({}))
    const phone = 'phone' in user ? user.phone : undefined
    return (phone && typeof phone === 'object' && !Array.isArray(phone) ? phone : {}) as {
      relay?: unknown
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
  }

  /** What is missing for the relay, or the relay and its token. */
  async function configuration(): Promise<Setup | { off: true } | { missing: string }> {
    if (!env.ULTIMATE_PHONE_RELAY && temporary) return { off: true }
    const configured = env.ULTIMATE_PHONE_RELAY || (await settings()).relay
    if (typeof configured !== 'string' || !configured)
      return { missing: 'Set "phone": { "relay": "wss://…" } in ~/.ultimate/settings.json' }
    if (!/^wss?:\/\/[^/\s]/.test(configured))
      return { missing: 'phone.relay must be a ws:// or wss:// URL' }
    const token = await readSecret(host.userHome, 'ULTIMATE_PHONE_RELAY_TOKEN')
    if (!token)
      return { missing: 'Add ULTIMATE_PHONE_RELAY_TOKEN in the Secrets panel (⌘K → Secrets)' }
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
    })().finally(() => (starting = undefined))
    return starting
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
        }
        if ('missing' in setup) return { state: 'unconfigured', error: setup.missing, ...base }
        return { state: 'off', ...base }
      }
      const state = await loadState(path)
      const shown = pairingStatus(state)
      return {
        state: connector.state,
        ...(connector.error && { error: connector.error }),
        relay,
        instance: instance!,
        devices: devices(state),
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
    start: ensure,
    stop() {
      stopped = true
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
