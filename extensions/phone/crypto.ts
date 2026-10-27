/** The crypto of the phone protocol (ultimate-ios `docs/protocol.md`) on `node:crypto`; pure, no state. */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  randomBytes,
} from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import type { PairingCode } from './refs.ts'

const LABEL = 'ultimate-phone/1'

export const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')
/** The bytes of base64url `text`, or undefined unless it is canonical base64url of exactly `length` bytes. */
export function fromB64u(text: unknown, length: number) {
  if (typeof text !== 'string') return undefined
  const bytes = Buffer.from(text, 'base64url')
  return bytes.length === length && b64u(bytes) === text ? bytes : undefined
}
/** Fresh random bytes as base64url, for tokens and ids. */
export const randomToken = (bytes = 32) => b64u(randomBytes(bytes))

/** An X25519 key pair: the private `key` object and the raw 32-byte public key. */
export type KeyPair = { key: KeyObject; pub: Buffer }
/** The pair of a raw 32-byte private key. */
export function keyPair(privateBytes: Uint8Array): KeyPair {
  const key = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), privateBytes]),
    format: 'der',
    type: 'pkcs8',
  })
  const x = key.export({ format: 'jwk' }).x
  return { key, pub: Buffer.from(x!, 'base64url') }
}
export const generateKeyPair = () => keyPair(randomBytes(32))
const publicKey = (raw: Uint8Array) =>
  createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: b64u(raw) }, format: 'jwk' })
const dh = (mine: KeyPair, theirs: Uint8Array) =>
  diffieHellman({ privateKey: mine.key, publicKey: publicKey(theirs) })

export type Session = { h: Buffer; kPM: Buffer; kMP: Buffer }
function session(
  ikm: Buffer,
  mPub: Uint8Array,
  pPub: Uint8Array,
  epPub: Uint8Array,
  emPub: Uint8Array,
): Session {
  const h = createHash('sha256')
    .update(Buffer.concat([Buffer.from(LABEL), mPub, pPub, epPub, emPub]))
    .digest()
  const okm = Buffer.from(hkdfSync('sha256', ikm, h, `${LABEL} session`, 64))
  return { h, kPM: okm.subarray(0, 32), kMP: okm.subarray(32) }
}
/** The Mac's view of the handshake: its static `M` and fresh `Em` against the phone's `P.pub` and `Ep.pub`. */
export function macSession(M: KeyPair, Em: KeyPair, pPub: Uint8Array, epPub: Uint8Array) {
  const ikm = Buffer.concat([dh(M, epPub), dh(M, pPub), dh(Em, epPub), dh(Em, pPub)])
  return session(ikm, M.pub, pPub, epPub, Em.pub)
}
/** The phone's view of the same handshake. */
export function phoneSession(P: KeyPair, Ep: KeyPair, mPub: Uint8Array, emPub: Uint8Array) {
  const ikm = Buffer.concat([dh(Ep, mPub), dh(P, mPub), dh(Ep, emPub), dh(P, emPub)])
  return session(ikm, mPub, P.pub, Ep.pub, emPub)
}

const counterBytes = (counter: number | bigint) => {
  const bytes = Buffer.alloc(8)
  bytes.writeBigUInt64BE(BigInt(counter))
  return bytes
}
/** `counter (8, big-endian) || ChaCha20-Poly1305(key, 4 zero bytes || counter, plaintext, aad)`. */
export function seal(
  key: Uint8Array,
  counter: number | bigint,
  plaintext: Uint8Array,
  aad: Uint8Array,
) {
  const prefix = counterBytes(counter)
  const cipher = createCipheriv(
    'chacha20-poly1305',
    key,
    Buffer.concat([Buffer.alloc(4), prefix]),
    {
      authTagLength: 16,
    },
  )
  cipher.setAAD(aad, { plaintextLength: plaintext.length })
  return Buffer.concat([prefix, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
}
/** The counter a frame carries, or undefined when it is too short to be one. */
export const frameCounter = (frame: Uint8Array) =>
  frame.length < 24 ? undefined : Buffer.from(frame.subarray(0, 8)).readBigUInt64BE()
/** The plaintext of a frame; throws when it does not authenticate. */
export function open(key: Uint8Array, frame: Uint8Array, aad: Uint8Array) {
  const bytes = Buffer.from(frame)
  const decipher = createDecipheriv(
    'chacha20-poly1305',
    key,
    Buffer.concat([Buffer.alloc(4), bytes.subarray(0, 8)]),
    { authTagLength: 16 },
  )
  decipher.setAAD(aad, { plaintextLength: bytes.length - 24 })
  decipher.setAuthTag(bytes.subarray(bytes.length - 16))
  return Buffer.concat([decipher.update(bytes.subarray(8, bytes.length - 16)), decipher.final()])
}

/** The key that seals a push for one phone: `HKDF(DH(P, M), salt = M.pub || P.pub)`. */
export function pushKey(M: KeyPair, pPub: Uint8Array) {
  return Buffer.from(
    hkdfSync('sha256', dh(M, pPub), Buffer.concat([M.pub, pPub]), `${LABEL} push`, 32),
  )
}
/** `nonce (12) || ChaCha20-Poly1305(kPush, nonce, plaintext, aad = "ultimate-push/1")`, base64url. */
export function sealPush(kPush: Uint8Array, plaintext: Uint8Array, nonce = randomBytes(12)) {
  const cipher = createCipheriv('chacha20-poly1305', kPush, nonce, { authTagLength: 16 })
  cipher.setAAD(Buffer.from('ultimate-push/1'), { plaintextLength: plaintext.length })
  return b64u(Buffer.concat([nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]))
}

/** `base64url(HMAC-SHA256(machineSecret, projectRoot))[0..22]`: the opaque id of a project, the same in every process. */
export const instanceId = (machineSecret: Uint8Array, projectRoot: string) =>
  b64u(createHmac('sha256', machineSecret).update(projectRoot).digest()).slice(0, 22)
/** `base64url(SHA-256(P.pub))[0..22]`. */
export const deviceId = (pPub: Uint8Array) =>
  b64u(createHash('sha256').update(pPub).digest()).slice(0, 22)
/** Lowercase hex SHA-256 of a token's base64url text, which is all the relay keeps of it. */
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex')

/** The code in a pairing QR text, `pairingQr`'s inverse. */
export function parsePairingQr(text: string): PairingCode {
  if (!text.startsWith('ultimate-pair:')) throw new Error('Not an ultimate-pair code')
  return JSON.parse(Buffer.from(text.slice('ultimate-pair:'.length), 'base64url').toString())
}
