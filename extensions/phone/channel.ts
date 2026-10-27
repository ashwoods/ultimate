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
/** A sealed frame is its plaintext plus an 8-byte counter and a 16-byte tag. */
const MAX_PLAINTEXT = MAX_FRAME - 24
/** A device's `lastSeen` moves at most this often. */
const SEEN_EVERY = 60 * 1000
/** Close codes of the protocol. */
export const PROTOCOL_ERROR = 4400
export const UNAUTHORIZED = 4401

/** The relay's side of one phone socket: bytes out, and a way to close it. */
export type Transport = { send(frame: Buffer): void; close(code: number): void }

export class Channel {
  #services: Services
  #transport: Transport
  #queue: Promise<void> = Promise.resolve()
  #outbox: Promise<void> = Promise.resolve()
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
  /**
   * Send an unsolicited `{ event, data }` message, in order. A phone removed from the state file by another process
   * is closed here (4401) instead of receiving it.
   */
  emit(event: string, data: unknown) {
    this.#outbox = this.#outbox
      .then(async () => {
        if (this.closed) return
        if (!(await this.#known())) return this.close(UNAUTHORIZED)
        this.#send({ event, data })
      })
      .catch(() => {
        // The state file could not be read; this event is lost, and the next call or event checks again.
      })
  }

  /** Whether the phone is in the state file now (an unreadable file is the caller's failure). */
  async #known() {
    const device = this.#device!
    return (await this.#services.state()).devices.find((entry) => entry.id === device.id)
  }

  /** Seal `message` for the phone. Over the frame limit, a list of `items` loses its oldest; anything else is refused. */
  #send(message: { id?: number; result?: object; error?: object; event?: string; data?: unknown }) {
    if (this.closed || !this.#session) return
    let body = Buffer.from(JSON.stringify(message))
    if (body.length > MAX_PLAINTEXT) {
      const field = message.result ? 'result' : 'data'
      const held = message[field] as { items?: unknown[] } | undefined
      if (Array.isArray(held?.items)) {
        const items = held.items.slice()
        while (items.length && body.length > MAX_PLAINTEXT) {
          items.shift()
          body = Buffer.from(JSON.stringify({ ...message, [field]: { ...held, items } }))
        }
      }
      if (body.length > MAX_PLAINTEXT) {
        if (message.id === undefined) return
        body = Buffer.from(
          JSON.stringify({ id: message.id, error: { message: 'Reply too large' } }),
        )
      }
    }
    this.#transport.send(seal(this.#session.kMP, this.#sent++, body, this.#session.h))
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
    const known = state.devices.find((device) => device.id === id)
    if (!known && !this.#services.pairing.pending) return this.close(UNAUTHORIZED)
    if (known) this.#seen(id, known.lastSeen)
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

  /** Note that the phone was here, unless it was noted less than a minute ago. */
  #seen(id: string, last = 0) {
    const now = Date.now()
    if (now - last < SEEN_EVERY) return
    this.#services
      .update((state) => {
        const known = state.devices.find((device) => device.id === id)
        if (known && now - (known.lastSeen ?? 0) >= SEEN_EVERY) known.lastSeen = now
      })
      .catch(() => {
        // A failed write only leaves the time as it was; the call itself goes on.
      })
  }

  async #call(id: number, method: string, params: Record<string, unknown>) {
    const device = this.#device!
    try {
      // Re-read the file: a phone removed by another process stops here (or at its next event), and only `pair` may come before pairing.
      const known = await this.#known()
      if (!known && method !== 'pair') return this.close(UNAUTHORIZED)
      if (known) this.#seen(device.id, known.lastSeen)
      const handler = Object.hasOwn(methods, method) ? methods[method] : undefined
      if (!handler) throw new RpcError(`Unknown method ${method}`)
      const result = await handler(params, {
        services: this.#services,
        device,
        signal: this.#closed.signal,
        emit: (event, data) => this.emit(event, data),
      })
      this.#send({ id, result })
    } catch (error) {
      if (!(error instanceof RpcError)) this.#services.log(`Phone: ${String(error)}`)
      this.#send({
        id,
        error: {
          message: error instanceof RpcError ? error.message : 'Something went wrong on the Mac',
        },
      })
    }
  }
}
