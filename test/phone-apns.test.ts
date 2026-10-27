import { generateKeyPairSync, verify } from 'node:crypto'
import { createServer } from 'node:http2'
import type { Http2Server } from 'node:http2'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, it } from 'vitest'
import { createApns } from '../extensions/phone/apns.ts'
import type { Apns, ApnsRequest } from '../extensions/phone/apns.ts'

const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const config = {
  keyId: 'KEY123',
  teamId: 'TEAM456',
  key: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
}

type Seen = { headers: Record<string, unknown>; body: string }
const open: { server: Http2Server; apns?: Apns }[] = []
afterEach(async () => {
  for (const { server, apns } of open.splice(0)) {
    apns?.close()
    await new Promise((done) => server.close(done))
  }
})

/** APNs on a cleartext HTTP/2 port in this process: answers with `reply(token)` and records what it was sent. */
async function apnsServer(reply: (token: string) => { status: number; body?: object }) {
  const seen: Seen[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      seen.push({ headers: request.headers, body: Buffer.concat(chunks).toString() })
      const { status, body } = reply(String(request.headers[':path']).split('/').at(-1)!)
      response.writeHead(status)
      response.end(body ? JSON.stringify(body) : '')
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const entry: (typeof open)[number] = { server }
  open.push(entry)
  const clock = { now: 1_700_000_000_000 }
  const apns = createApns(config, {
    origins: { sandbox: origin, production: origin },
    now: () => clock.now,
  })
  entry.apns = apns
  return { seen, apns, clock }
}

const request = (token: string): ApnsRequest => ({
  token,
  env: 'sandbox',
  type: 'alert',
  topic: 'app.test',
  priority: 10,
  collapseId: 'job-1',
  payload: { aps: { alert: 'hi' } },
})
const claims = (authorization: unknown) => {
  const jwt = String(authorization).replace(/^bearer /, '')
  const [header, body, signature] = jwt.split('.')
  const ok = verify(
    'sha256',
    Buffer.from(`${header}.${body}`),
    { key: keys.publicKey, dsaEncoding: 'ieee-p1363' },
    Buffer.from(signature, 'base64url'),
  )
  return {
    ok,
    header: JSON.parse(Buffer.from(header, 'base64url').toString()),
    body: JSON.parse(Buffer.from(body, 'base64url').toString()),
    jwt,
  }
}

it('posts the notification over HTTP/2 with headers and a provider token the public key verifies', async () => {
  const { seen, apns } = await apnsServer(() => ({ status: 200 }))
  expect(await apns.send(request('abcd'))).toEqual({ status: 200 })
  expect(seen[0].headers).toMatchObject({
    ':method': 'POST',
    ':path': '/3/device/abcd',
    'apns-push-type': 'alert',
    'apns-topic': 'app.test',
    'apns-priority': '10',
    'apns-collapse-id': 'job-1',
  })
  expect(JSON.parse(seen[0].body)).toEqual({ aps: { alert: 'hi' } })
  const token = claims(seen[0].headers.authorization)
  expect(token.ok).toBe(true)
  expect(token.header).toEqual({ alg: 'ES256', kid: 'KEY123' })
  expect(token.body).toEqual({ iss: 'TEAM456', iat: 1_700_000_000 })
})

it('reuses the provider token for 50 minutes and signs a new one after', async () => {
  const { seen, apns, clock } = await apnsServer(() => ({ status: 200 }))
  await apns.send(request('a1'))
  clock.now += 49 * 60 * 1000
  await apns.send(request('a2'))
  clock.now += 2 * 60 * 1000
  await apns.send(request('a3'))
  const [a, b, c] = seen.map((s) => claims(s.headers.authorization))
  expect(b.jwt).toBe(a.jwt)
  expect(c.jwt).not.toBe(a.jwt)
  expect([a.ok, c.ok]).toEqual([true, true])
  expect(c.body.iat).toBe(1_700_000_000 + 51 * 60)
})

it('reports the status and reason APNs answers with', async () => {
  const { apns } = await apnsServer((token) =>
    token === 'gone'
      ? { status: 410, body: { reason: 'Unregistered', timestamp: 1 } }
      : { status: 400, body: { reason: 'BadDeviceToken' } },
  )
  expect(await apns.send(request('gone'))).toEqual({ status: 410, reason: 'Unregistered' })
  expect(await apns.send(request('bad'))).toEqual({ status: 400, reason: 'BadDeviceToken' })
})
