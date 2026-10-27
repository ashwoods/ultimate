/** `~/.ultimate/phone.json`: this Mac's identity and its paired phones, shared by every instance process. */
import { randomBytes } from 'node:crypto'
import { link, open, rm, stat } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { readJson, writeJson } from '../../lib/json-file.ts'
import { b64u, keyPair } from './crypto.ts'
import type { KeyPair } from './crypto.ts'

export type PhoneDevice = {
  /** `deviceId(P.pub)`. */
  id: string
  name: string
  /** `P.pub`, base64url. */
  key: string
  /** `tokenHash(deviceToken)`: what the relay accepts. */
  tokenHash: string
  addedAt: number
  lastSeen?: number
  push?: { token: string; env: 'sandbox' | 'production' }
  /** Live Activity push tokens by `activityKey` (job ids are per instance). */
  activities?: Record<string, string>
  /** `<instance>:<job>` of the alerts already sent to this phone, newest last and bounded. */
  alerted?: string[]
}
export type PhoneState = {
  /** Names the relay's Durable Object. */
  machine: string
  /** Derives instance ids; never leaves the Mac. */
  machineSecret: string
  /** The static key pair `M`, raw bytes as base64url. */
  keys: { private: string; public: string }
  /** The Mac's name as the phone shows it. */
  name: string
  devices: PhoneDevice[]
}

/** `ULTIMATE_PHONE_STATE`, else `phone.json` in the user's `.ultimate`. */
export const statePath = (userHome: string, env: NodeJS.ProcessEnv = process.env) =>
  env.ULTIMATE_PHONE_STATE ?? join(userHome, '.ultimate/phone.json')

/** The Mac's static key pair `M`. */
export const macKeys = (state: PhoneState): KeyPair =>
  keyPair(Buffer.from(state.keys.private, 'base64url'))

function fresh(): PhoneState {
  const secret = randomBytes(32)
  return {
    machine: b64u(randomBytes(16)),
    machineSecret: b64u(randomBytes(32)),
    keys: { private: b64u(secret), public: b64u(keyPair(secret).pub) },
    name: hostname(),
    devices: [],
  }
}

/** The state, created (mode 0600) on first use; another process creating it first wins. */
export async function loadState(path: string): Promise<PhoneState> {
  const existing = await readJson<PhoneState | undefined>(path, undefined)
  if (existing) return existing
  const staging = `${path}.${process.pid}.new`
  try {
    await writeJson(staging, fresh(), { mode: 0o600 })
    await link(staging, path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
  } finally {
    await rm(staging, { force: true })
  }
  return (await readJson<PhoneState | undefined>(path, undefined))!
}

/** The key of a job's Live Activity token: job ids repeat across instances. */
export const activityKey = (instance: string, job: number) => `${instance}:${job}`

/** A lock file older than this is left behind by a process that died. */
const STALE_LOCK_MS = 10_000

/** Run `work` holding the lock file beside `path`, so processes change the state one at a time. */
async function locked<T>(path: string, work: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`
  for (let attempt = 0; ; attempt++) {
    try {
      await (await open(lock, 'wx', 0o600)).close()
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const age = await stat(lock).then(
      (info) => Date.now() - info.mtimeMs,
      () => 0,
    )
    if (age > STALE_LOCK_MS) await rm(lock, { force: true })
    else await sleep(Math.min(5 * 2 ** Math.min(attempt, 4), 80))
  }
  try {
    return await work()
  } finally {
    await rm(lock, { force: true })
  }
}

const writes = new Map<string, Promise<unknown>>()
/** Read the state fresh, change it and write it back (mode 0600), one change at a time across processes. */
export function updateState(path: string, modify: (state: PhoneState) => void) {
  const operation = (writes.get(path) ?? Promise.resolve())
    .catch(() => {
      // The previous caller receives its failure; later writes must still run.
    })
    .then(() =>
      locked(path, async () => {
        const state = await loadState(path)
        modify(state)
        await writeJson(path, state, { mode: 0o600 })
      }),
    )
  writes.set(path, operation)
  return operation
}
