/** One phone's end-to-end encrypted channel through the relay: handshake, sealed frames with strict counters, JSON RPC. */
import {
  b64u,
  deviceId,
  frameCounter,
  fromB64u,
  generateKeyPair,
  macSession,
  open,
  seal,
} from './crypto.ts'
import type { Session } from './crypto.ts'
import { methods, RpcError } from './methods.ts'
import type { Call, Services } from './methods.ts'
import { macKeys } from './state.ts'

const MAX_FRAME = 1024 * 1024
/** Close codes of the protocol. */
export const PROTOCOL_ERROR = 4400
export const UNAUTHORIZED = 4401

/** The relay's side of one phone socket: bytes out, and a way to close it. */
export type Transport = { send(frame: Buffer): void; close(code: number): void }

export class Channel {
  #services: Services
  #transport: Transport
  #queue: Promise<void> = Promise.resolve()
  #session?: Session
  #device?: Call['device']
  #sent = 1n
  #received = 0n
  #closed = new AbortController()

  constructor(services: Services, transport: Transport) {
    this.#services = services
    this.#transport = transport
  }

  /** The phone's `deviceId` once its hello was accepted. */
  get device() {
    return this.#device?.id
  }
  get closed() {
    return this.#closed.signal.aborted
  }

  /** One binary frame from the phone. Frames are handled in order. */
  receive(frame: Buffer) {
    this.#queue = this.#queue
      .then(() => this.#handle(frame))
      .catch(() => this.close(PROTOCOL_ERROR))
  }
  /** Close the phone's socket with `code`. */
  close(code: number) {
    if (this.closed) return
    this.#closed.abort()
    this.#transport.close(code)
  }
  /** The phone's socket is gone already. */
  dispose() {
    this.#closed.abort()
  }
  /** Send an unsolicited `{ event, data }` message. */
  emit(event: string, data: unknown) {
    this.#send({ event, data })
  }

  #send(message: object) {
    if (this.closed || !this.#session) return
    this.#transport.send(
      seal(this.#session.kMP, this.#sent++, Buffer.from(JSON.stringify(message)), this.#session.h),
    )
  }

  async #handle(frame: Buffer) {
    if (this.closed) return
    if (frame.length > MAX_FRAME) return this.close(PROTOCOL_ERROR)
    if (!this.#session) return this.#hello(frame)
    if (frameCounter(frame) !== this.#received) return this.close(PROTOCOL_ERROR)
    let message: { id?: unknown; method?: unknown; params?: unknown }
    try {
      message = JSON.parse(open(this.#session.kPM, frame, this.#session.h).toString())
    } catch {
      return this.close(PROTOCOL_ERROR)
    }
    this.#received++
    const { id, method, params } = message
    if (
      !Number.isInteger(id) ||
      typeof method !== 'string' ||
      (params !== undefined &&
        (typeof params !== 'object' || params === null || Array.isArray(params)))
    )
      return this.close(PROTOCOL_ERROR)
    this.#call(id as number, method, (params ?? {}) as Record<string, unknown>).catch(() =>
      this.close(PROTOCOL_ERROR),
    )
  }

  async #hello(frame: Buffer) {
    let hello: { t?: unknown; v?: unknown; device?: unknown; eph?: unknown }
    try {
      hello = JSON.parse(frame.toString())
    } catch {
      return this.close(PROTOCOL_ERROR)
    }
    const key = fromB64u(hello.device, 32)
    const eph = fromB64u(hello.eph, 32)
    if (hello.t !== 'hello' || hello.v !== 1 || !key || !eph) return this.close(PROTOCOL_ERROR)
    const id = deviceId(key)
    const state = await this.#services.state()
    if (!state.devices.some((device) => device.id === id) && !this.#services.pairing.pending)
      return this.close(UNAUTHORIZED)
    const ephemeral = generateKeyPair()
    this.#session = macSession(macKeys(state), ephemeral, key, eph)
    this.#device = { id, key }
    this.#transport.send(
      Buffer.from(
        JSON.stringify({
          t: 'welcome',
          eph: b64u(ephemeral.pub),
          proof: b64u(seal(this.#session.kMP, 0, Buffer.alloc(0), this.#session.h)),
        }),
      ),
    )
  }

  async #call(id: number, method: string, params: Record<string, unknown>) {
    const device = this.#device!
    try {
      // Re-read the file: a phone revoked from another instance stops here, and only `pair` may come before pairing.
      const known = (await this.#services.state()).devices.some((entry) => entry.id === device.id)
      if (!known && method !== 'pair') return this.close(UNAUTHORIZED)
      const handler = methods[method]
      if (!handler) throw new RpcError(`Unknown method ${method}`)
      const result = await handler(params, {
        services: this.#services,
        device,
        signal: this.#closed.signal,
        emit: (event, data) => this.emit(event, data),
      })
      this.#send({ id, result })
    } catch (error) {
      this.#send({ id, error: { message: error instanceof Error ? error.message : String(error) } })
    }
  }
}
