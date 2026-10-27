/** This instance's outbound WebSocket to the relay: reconnects, and runs a `Channel` for each phone socket it announces. */
import { Channel } from './channel.ts'
import type { Services } from './methods.ts'

/** The part of a WebSocket the connector uses; Node's global `WebSocket` fits. */
export interface RelaySocket {
  send(data: string): void
  close(code?: number): void
  addEventListener(type: 'open', listener: () => void): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  addEventListener(
    type: 'close',
    listener: (event: { code: number; reason?: string }) => void,
  ): void
  addEventListener(type: 'error', listener: (event: { message?: string }) => void): void
}
export type Connect = (url: string, headers: Record<string, string>) => RelaySocket

export type ConnectorState = 'connecting' | 'online' | 'error'

const MIN_DELAY = 1000
const MAX_DELAY = 30000
/** The relay closed this socket because another process of the same instance connected. */
const REPLACED = 4409

export type ConnectorOptions = {
  relay: string
  token: string
  machine: string
  instance: string
  services: Services
  connect: Connect
  /** Called each time the socket opens: send what the relay must know (`devices`, a pending pairing). */
  opened(): void
}

export class Connector {
  #options: ConnectorOptions
  #socket?: RelaySocket
  #channels = new Map<string, Channel>()
  #timer?: ReturnType<typeof setTimeout>
  #failures = 0
  #stopped = true
  state: ConnectorState = 'connecting'
  error?: string
  /** Another process took the relay socket: this connector does not reconnect. */
  replaced = false

  constructor(options: ConnectorOptions) {
    this.#options = options
  }

  start() {
    this.#stopped = false
    this.#open()
  }
  stop() {
    this.#stopped = true
    clearTimeout(this.#timer)
    const socket = this.#socket
    this.#socket = undefined
    this.#drop()
    socket?.close(1000)
  }

  /** Send a relay message; false while the socket is not open. */
  send(message: object) {
    if (this.state !== 'online') return false
    this.#socket!.send(JSON.stringify(message))
    return true
  }
  /** Replace the relay's accepted device tokens with those in the state file. */
  async sendDevices() {
    const state = await this.#options.services.state()
    this.send({ t: 'devices', tokens: state.devices.map((device) => device.tokenHash) })
  }
  /** Close every open conn of `device`. */
  closeDevice(device: string, code: number) {
    for (const channel of this.#channels.values())
      if (channel.device === device) channel.close(code)
  }

  #open() {
    const { relay, token, machine, instance, connect } = this.#options
    this.state = 'connecting'
    const url = new URL(`v1/m/${machine}/mac`, relay.endsWith('/') ? relay : `${relay}/`)
    url.searchParams.set('instance', instance)
    let socket: RelaySocket
    try {
      socket = connect(url.href, { Authorization: `Bearer ${token}` })
    } catch (error) {
      this.#fail(error instanceof Error ? error.message : String(error))
      return
    }
    this.#socket = socket
    socket.addEventListener('open', () => {
      if (this.#socket !== socket) return
      this.state = 'online'
      this.error = undefined
      this.#failures = 0
      this.#options.opened()
    })
    socket.addEventListener('message', (event) => {
      if (this.#socket === socket) this.#message(event.data)
    })
    socket.addEventListener('error', (event) => {
      if (this.#socket === socket) this.error = event.message || 'Could not reach the relay'
    })
    socket.addEventListener('close', (event) => {
      if (this.#socket !== socket) return
      this.#socket = undefined
      this.#drop()
      if (event.code === REPLACED) {
        // Another process of this instance connected; reconnecting would only take the socket back and forth.
        this.state = 'error'
        this.error = 'Another process of this project took over the relay connection'
        this.replaced = true
        return
      }
      this.#fail(this.error ?? (event.reason || `The relay closed the connection (${event.code})`))
    })
  }

  #fail(message: string) {
    this.state = 'error'
    this.error = message
    if (this.#stopped) return
    const delay = Math.min(MAX_DELAY, MIN_DELAY * 2 ** this.#failures++)
    // Jitter keeps instances that lost the relay together from reconnecting together.
    this.#timer = setTimeout(() => this.#open(), delay * (0.5 + Math.random() / 2))
    this.#timer.unref()
  }

  #drop() {
    for (const channel of this.#channels.values()) channel.dispose()
    this.#channels.clear()
  }

  #message(data: unknown) {
    let message: { t?: unknown; conn?: unknown; data?: unknown }
    try {
      message = JSON.parse(String(data))
    } catch {
      // Not JSON: the relay sends only JSON, so there is nothing to answer.
      return
    }
    const conn = message.conn
    if (typeof conn !== 'string') return
    if (message.t === 'open') {
      const channel = new Channel(this.#options.services, {
        send: (frame) => this.send({ t: 'data', conn, data: frame.toString('base64') }),
        close: (code) => {
          this.send({ t: 'close', conn, code })
          this.#channels.delete(conn)
        },
      })
      this.#channels.set(conn, channel)
    } else if (message.t === 'data' && typeof message.data === 'string') {
      this.#channels.get(conn)?.receive(Buffer.from(message.data, 'base64'))
    } else if (message.t === 'close') {
      this.#channels.get(conn)?.dispose()
      this.#channels.delete(conn)
    }
  }
}
