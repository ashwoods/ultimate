/** Apple Push Notification service over HTTP/2 with a provider token (ES256 JWT, cached under the hour Apple allows). */
import { createPrivateKey, sign } from 'node:crypto'
import { connect, constants } from 'node:http2'
import type { ClientHttp2Session } from 'node:http2'

export type ApnsConfig = {
  keyId: string
  teamId: string
  /** The `.p8` PEM. */
  key: string
}
export type ApnsEnv = 'sandbox' | 'production'
export type ApnsRequest = {
  /** The device's (or Live Activity's) push token, hex. */
  token: string
  env: ApnsEnv
  type: 'alert' | 'liveactivity'
  /** `apns-topic`: the bundle id, or `<bundle id>.push-type.liveactivity`. */
  topic: string
  priority: 5 | 10
  collapseId?: string
  payload: object
}
/** APNs' answer: 200 delivered to Apple, else an HTTP status with the `reason` of its JSON body. */
export type ApnsResult = { status: number; reason?: string }
export type Apns = { send: (request: ApnsRequest) => Promise<ApnsResult>; close: () => void }

const ORIGINS: Record<ApnsEnv, string> = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
}
/** Apple refuses a token older than an hour and one renewed more often than every 20 minutes. */
const TOKEN_LIFE = 50 * 60 * 1000
const REQUEST_TIMEOUT = 15000
const IDLE_TIMEOUT = 60000

const b64u = (value: string | Buffer) => Buffer.from(value).toString('base64url')

/** The provider token: `header.claims.signature`, signed with the team's key. */
export function providerToken(config: ApnsConfig, issuedAt: number) {
  const signing = `${b64u(JSON.stringify({ alg: 'ES256', kid: config.keyId }))}.${b64u(JSON.stringify({ iss: config.teamId, iat: Math.floor(issuedAt / 1000) }))}`
  const signature = sign('sha256', Buffer.from(signing), {
    key: createPrivateKey(config.key),
    dsaEncoding: 'ieee-p1363',
  })
  return `${signing}.${b64u(signature)}`
}

/** `origins` and `now` are for tests. */
export function createApns(
  config: ApnsConfig,
  options: { origins?: Record<ApnsEnv, string>; now?: () => number } = {},
): Apns {
  const origins = options.origins ?? ORIGINS
  const now = options.now ?? Date.now
  const sessions = new Map<string, ClientHttp2Session>()
  let cached: { token: string; at: number } | undefined

  const bearer = () => {
    const at = now()
    if (!cached || at - cached.at > TOKEN_LIFE) cached = { token: providerToken(config, at), at }
    return cached.token
  }
  function session(origin: string) {
    const existing = sessions.get(origin)
    if (existing && !existing.closed && !existing.destroyed) return existing
    const created = connect(origin)
    created.unref()
    // A failed connection reaches each request through its own listener; this one only keeps it from being unhandled.
    created.on('error', () => {})
    created.on('close', () => {
      if (sessions.get(origin) === created) sessions.delete(origin)
    })
    created.setTimeout(IDLE_TIMEOUT, () => created.close())
    sessions.set(origin, created)
    return created
  }

  return {
    send: (request) =>
      new Promise((resolve, reject) => {
        const body = JSON.stringify(request.payload)
        const link = session(origins[request.env])
        const failed = (error: Error) => reject(error)
        link.once('error', failed)
        const stream = link.request({
          ':method': 'POST',
          ':path': `/3/device/${request.token}`,
          authorization: `bearer ${bearer()}`,
          'apns-push-type': request.type,
          'apns-topic': request.topic,
          'apns-priority': String(request.priority),
          ...(request.collapseId && { 'apns-collapse-id': request.collapseId }),
          'content-type': 'application/json',
        })
        let status = 0
        const chunks: Buffer[] = []
        stream.setTimeout(REQUEST_TIMEOUT, () => {
          stream.close(constants.NGHTTP2_CANCEL)
          reject(new Error('APNs did not answer in time'))
        })
        stream.on('response', (headers) => void (status = Number(headers[':status'])))
        stream.on('data', (chunk: Buffer) => void chunks.push(chunk))
        stream.on('error', reject)
        stream.on('close', () => link.off('error', failed))
        stream.on('end', () => {
          let reason: string | undefined
          try {
            reason = (JSON.parse(Buffer.concat(chunks).toString()) as { reason?: string }).reason
          } catch {
            // Delivered answers have no body.
          }
          if (status === 403) cached = undefined
          resolve({ status, ...(reason && { reason }) })
        })
        stream.end(body)
      }),
    close() {
      for (const link of sessions.values()) link.close()
      sessions.clear()
    },
  }
}
