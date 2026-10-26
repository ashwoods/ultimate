import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import {
  b64u,
  deviceId,
  frameCounter,
  instanceId,
  keyPair,
  macSession,
  open,
  parsePairingQr,
  pairingQr,
  phoneSession,
  pushKey,
  seal,
  sealPush,
  tokenHash,
} from '../extensions/phone/crypto.ts'

const vectors = JSON.parse(
  readFileSync(new URL('./fixtures/phone-vectors.json', import.meta.url), 'utf8'),
)
const hex = (text: string) => Buffer.from(text, 'hex')
const pair = (name: 'M' | 'P' | 'Ep' | 'Em') => keyPair(hex(vectors.keys[name].private))

it('derives the public keys, ids and token hash of the reference vectors', () => {
  for (const name of ['M', 'P', 'Ep', 'Em'] as const)
    expect(pair(name).pub.toString('hex')).toBe(vectors.keys[name].public)
  expect(deviceId(pair('P').pub)).toBe(vectors.device)
  expect(instanceId(hex(vectors.instance.machineSecret), vectors.instance.projectRoot)).toBe(
    vectors.instance.id,
  )
  expect(tokenHash(vectors.tokenHash.token)).toBe(vectors.tokenHash.sha256)
})

it('reaches the reference session from both sides', () => {
  const mac = macSession(pair('M'), pair('Em'), pair('P').pub, pair('Ep').pub)
  const phone = phoneSession(pair('P'), pair('Ep'), pair('M').pub, pair('Em').pub)
  for (const session of [mac, phone]) {
    expect(session.h.toString('hex')).toBe(vectors.h)
    expect(session.kPM.toString('hex')).toBe(vectors.kPM)
    expect(session.kMP.toString('hex')).toBe(vectors.kMP)
  }
  const proof = seal(mac.kMP, 0, Buffer.alloc(0), mac.h)
  expect(b64u(proof)).toBe(vectors.welcome.proof)
  expect(open(phone.kMP, proof, phone.h)).toHaveLength(0)
})

it('seals and opens the reference frames', () => {
  const { h, kPM, kMP } = macSession(pair('M'), pair('Em'), pair('P').pub, pair('Ep').pub)
  const [fromPhone, fromMac] = vectors.frames
  expect(seal(kPM, 0, Buffer.from(fromPhone.plaintext), h).toString('hex')).toBe(fromPhone.frame)
  expect(seal(kMP, 1, Buffer.from(fromMac.plaintext), h).toString('hex')).toBe(fromMac.frame)
  expect(open(kPM, hex(fromPhone.frame), h).toString()).toBe(fromPhone.plaintext)
  expect(frameCounter(hex(fromMac.frame))).toBe(1n)
  const tampered = hex(fromPhone.frame)
  tampered[20] ^= 1
  expect(() => open(kPM, tampered, h)).toThrow('bad decrypt')
})

it('derives the push key and seals a push like the reference', () => {
  const key = pushKey(pair('M'), pair('P').pub)
  expect(key.toString('hex')).toBe(vectors.push.kPush)
  expect(sealPush(key, Buffer.from(vectors.push.plaintext), Buffer.alloc(12, 6))).toBe(
    vectors.push.enc,
  )
})

it('writes and parses the pairing QR text', () => {
  expect(pairingQr(vectors.pairing.json)).toBe(vectors.pairing.qr)
  expect(parsePairingQr(vectors.pairing.qr)).toEqual(vectors.pairing.json)
})
