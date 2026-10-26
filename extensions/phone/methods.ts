/** The methods a paired phone can call. Add a method to `methods`; `channel.ts` dispatches by name. */
import type { ExtensionHost } from '../../server/extensions.ts'
import { instanceId } from './crypto.ts'
import type { Pairing } from './pairing.ts'
import type { PhoneState } from './state.ts'

/** What a method may use: the shared state file, this instance and the process around it. */
export type Services = {
  /** This instance's id (`instanceId` of its project root). */
  instance: string
  host: Pick<ExtensionHost, 'projects'>
  pairing: Pairing
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
  emit(event: string, data: unknown): void
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
