/** The methods a paired phone can call. Add a method to `methods`; `channel.ts` dispatches by name. */
import type { ExtensionHost } from '../../server/extensions.ts'
import type { VoiceLiveService } from '../voice-live/api.ts'
import { instanceId, randomToken } from './crypto.ts'
import type { Feed } from './feed.ts'
import { MAX_ITEMS } from './feed.ts'
import type { Pairing } from './pairing.ts'
import type { PhoneState } from './state.ts'

/** What a method may use: the shared state file, this instance and the process around it. */
export type Services = {
  /** This instance's id (`instanceId` of its project root). */
  instance: string
  host: Pick<ExtensionHost, 'projects'>
  pairing: Pairing
  /** Voice, which `say` talks into. */
  voice: Pick<VoiceLiveService, 'open' | 'heard'>
  feed: Pick<Feed, 'join'>
  state(): Promise<PhoneState>
  update(modify: (state: PhoneState) => void): Promise<void>
  /** The user's `phone` settings object. */
  settings(): Promise<{ elevenlabs?: { voice?: string; model?: string } }>
  secret(name: string): Promise<string | undefined>
  fetch: typeof fetch
}
/** The phone making a call. */
export type Call = {
  services: Services
  /** Its `deviceId` and raw public key. */
  device: { id: string; key: Buffer }
  /** Aborted when its channel closes. */
  signal: AbortSignal
  /** Send a `{ event, data }` message to this phone. */
  emit: (event: string, data: unknown) => void
}
export type Method = (params: Record<string, unknown>, call: Call) => Promise<object> | object

/** A failure whose sentence the phone shows. */
export class RpcError extends Error {}

const text = (value: unknown, what: string, max = 200) => {
  if (typeof value !== 'string' || !value || value.length > max)
    throw new RpcError(`${what} is missing`)
  return value
}
const hex = (value: unknown, what: string) => {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{1,512}$/.test(value))
    throw new RpcError(`${what} must be a hex string`)
  return value
}

/** The ElevenLabs voice used when `phone.elevenlabs.voice` is not set: Sarah, one of its standard voices. */
export const DEFAULT_VOICE = 'EXAVITQu4vr4xnSDxMaL'
export const DEFAULT_MODEL = 'eleven_flash_v2_5'
const MAX_ACTIVITIES = 20

/** The Voice phone session each channel opened, and the feed subscription each holds. */
const sessions = new WeakMap<AbortSignal, Promise<unknown>>()
const subscriptions = new WeakMap<AbortSignal, () => void>()

export const methods: Record<string, Method> = {
  async pair(params, { services, device, signal }) {
    const name =
      typeof params.name === 'string' && params.name ? params.name.slice(0, 100) : 'iPhone'
    const request = services.pairing.request(params.token, {
      device: device.id,
      name,
      key: device.key,
    })
    signal.addEventListener('abort', () => services.pairing.abandon(device.id), { once: true })
    let paired
    try {
      paired = await request
    } catch (error) {
      throw new RpcError((error as Error).message)
    }
    const state = await services.state()
    return { deviceToken: paired.deviceToken, machine: state.machine, name: state.name }
  },

  ping: () => ({}),

  async say(params, { services, device, signal }) {
    const id = text(params.id, 'id', 100)
    const said = text(params.text, 'text', 8000).trim()
    if (!said) throw new RpcError('text is missing')
    if (params.via !== 'voice' && params.via !== 'text')
      throw new RpcError('via must be "voice" or "text"')
    // One Voice session per channel; a reconnect is a new session. A failed open is tried again by the next say.
    let opened = sessions.get(signal)
    if (!opened) {
      opened = services.voice.open(`${device.id}:${randomToken(8)}`)
      sessions.set(signal, opened)
      opened.catch(() => sessions.delete(signal))
    }
    try {
      await opened
      await services.voice.heard(said, id, params.via)
    } catch (error) {
      throw new RpcError(error instanceof Error ? error.message : String(error))
    }
    return {}
  },

  async 'feed.subscribe'(params, { services, signal, emit }) {
    const asked = params.limit ?? 50
    if (typeof asked !== 'number' || !Number.isInteger(asked) || asked < 1)
      throw new RpcError('limit must be a positive integer')
    const { items, leave } = await services.feed.join(Math.min(asked, MAX_ITEMS), (changed) =>
      emit('feed', { items: changed }),
    )
    subscriptions.get(signal)?.()
    if (signal.aborted) leave()
    else {
      subscriptions.set(signal, leave)
      signal.addEventListener('abort', leave, { once: true })
    }
    return { items }
  },

  async instances(_params, { services }) {
    const secret = Buffer.from((await services.state()).machineSecret, 'base64url')
    const projects = await services.host.projects()
    return {
      instances: projects.flatMap((project) =>
        project.root
          ? [
              {
                id: instanceId(secret, project.root),
                name: project.name,
                running: project.current || project.running !== undefined,
                current: project.current,
              },
            ]
          : [],
      ),
    }
  },

  async 'push.register'(params, { services, device }) {
    const token = hex(params.token, 'token')
    if (params.env !== 'sandbox' && params.env !== 'production')
      throw new RpcError('env must be "sandbox" or "production"')
    const env = params.env
    await services.update((state) => {
      const known = state.devices.find((entry) => entry.id === device.id)
      if (known) known.push = { token, env }
    })
    return {}
  },

  async 'activity.register'(params, { services, device }) {
    const job = params.job
    if (typeof job !== 'number' || !Number.isInteger(job))
      throw new RpcError('job must be an integer')
    const token = hex(params.token, 'token')
    await services.update((state) => {
      const known = state.devices.find((entry) => entry.id === device.id)
      if (!known) return
      const activities = (known.activities ??= {})
      delete activities[job]
      activities[job] = token
      for (const old of Object.keys(activities).slice(0, -MAX_ACTIVITIES)) delete activities[old]
    })
    return {}
  },

  /** A single-use token for the phone's own ElevenLabs text-to-speech socket; the API key stays on the Mac. */
  async 'tts.token'(_params, { services, signal }) {
    const key = await services.secret('ELEVENLABS_API_KEY')
    if (!key) throw new RpcError('ELEVENLABS_API_KEY is not set')
    const response = await services.fetch(
      'https://api.elevenlabs.io/v1/single-use-token/tts_websocket',
      {
        method: 'POST',
        headers: { 'xi-api-key': key },
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      },
    )
    if (!response.ok)
      throw new RpcError(`ElevenLabs refused the token request (${response.status})`)
    const { token } = (await response.json()) as { token?: unknown }
    if (typeof token !== 'string' || !token)
      throw new RpcError('ElevenLabs answered without a token')
    const { elevenlabs } = await services.settings()
    return {
      provider: 'elevenlabs',
      token,
      voice: text(elevenlabs?.voice ?? DEFAULT_VOICE, 'voice'),
      model: text(elevenlabs?.model ?? DEFAULT_MODEL, 'model'),
    }
  },
}
