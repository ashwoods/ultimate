/** The pairing this instance showed a code for: one token, ten minutes, and the one phone waiting for the user's answer. */
import { timingSafeEqual } from 'node:crypto'
import { randomToken, tokenHash } from './crypto.ts'

export const PAIRING_MS = 10 * 60 * 1000

/** A phone asking to be added. */
export type PairRequest = { device: string; name: string; key: Buffer }
export type Paired = { deviceToken: string }

export type PairingHooks = {
  /** Tell the relay to accept `hash` until `expires`, or (0) to forget it. */
  publish(hash: string, expires: number): void
  /** Add the phone and answer with its token. */
  complete(request: PairRequest): Promise<Paired>
}

type Waiting = PairRequest & { resolve(result: Paired): void; reject(error: Error): void }
type Pending = { token: string; expires: number; waiting?: Waiting }

export class Pairing {
  #pending?: Pending
  #timer?: ReturnType<typeof setTimeout>
  #hooks: PairingHooks

  constructor(hooks: PairingHooks) {
    this.#hooks = hooks
  }

  /** The token that is still valid, and who waits on it. */
  get pending() {
    if (this.#pending && Date.now() >= this.#pending.expires)
      this.#end(new Error('Pairing expired'))
    return (
      this.#pending && {
        token: this.#pending.token,
        expires: this.#pending.expires,
        request: this.#pending.waiting && {
          device: this.#pending.waiting.device,
          name: this.#pending.waiting.name,
        },
      }
    )
  }

  /** A new token; a token shown before stops working. */
  start() {
    this.#end(new Error('Pairing was declined'))
    const token = randomToken()
    const expires = Date.now() + PAIRING_MS
    this.#pending = { token, expires }
    this.#timer = setTimeout(() => this.pending, PAIRING_MS + 1)
    this.#timer.unref()
    this.#hooks.publish(tokenHash(token), expires)
    return { token, expires }
  }
  cancel() {
    this.#end(new Error('Pairing was declined'))
  }
  /** The relay forgot the pending token (it reconnected): tell it again. */
  republish() {
    if (this.pending) this.#hooks.publish(tokenHash(this.#pending!.token), this.#pending!.expires)
  }

  /** A phone's `pair`: resolves when the user allows it, rejects when they decline or the code expires. */
  request(token: unknown, request: PairRequest) {
    const pending = this.pending
    if (!pending) return Promise.reject(new Error('Pairing expired'))
    const given = Buffer.from(typeof token === 'string' ? token : '')
    const wanted = Buffer.from(pending.token)
    if (given.length !== wanted.length || !timingSafeEqual(given, wanted))
      return Promise.reject(new Error('Pairing code is not valid'))
    if (this.#pending!.waiting)
      return Promise.reject(new Error('Another phone is waiting to be allowed'))
    return new Promise<Paired>((resolve, reject) => {
      this.#pending!.waiting = { ...request, resolve, reject }
    })
  }
  /** The phone went away before the user answered. */
  abandon(device: string) {
    if (this.#pending?.waiting?.device === device) this.#pending.waiting = undefined
  }

  async allow(device: string) {
    const waiting = this.#waiting(device)
    let paired: Paired
    try {
      paired = await this.#hooks.complete(waiting)
    } catch (error) {
      this.#end(error as Error)
      throw error
    }
    waiting.resolve(paired)
    this.#end()
  }
  deny(device: string) {
    this.#waiting(device)
    this.#end(new Error('Pairing was declined'))
  }

  #waiting(device: string) {
    const waiting = this.pending && this.#pending!.waiting
    if (!waiting || waiting.device !== device) throw new Error('That phone is not waiting')
    return waiting
  }
  /** Withdraw the token; a waiting phone gets `reason`. */
  #end(reason?: Error) {
    const pending = this.#pending
    this.#pending = undefined
    clearTimeout(this.#timer)
    if (!pending) return
    const withdraw = () => this.#hooks.publish(tokenHash(pending.token), 0)
    if (!pending.waiting) return withdraw()
    pending.waiting.reject(reason ?? new Error('Pairing expired'))
    // The relay closes a pairing phone's socket (4401) when the token goes; its error answer must reach it first.
    setImmediate(withdraw)
  }
}
