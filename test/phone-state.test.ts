import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { loadState } from '../extensions/phone/state.ts'
import type { PhoneDevice } from '../extensions/phone/state.ts'
import { temp } from './helpers.ts'

const device = (id: string): PhoneDevice => ({
  id,
  name: id,
  key: id,
  tokenHash: id,
  addedAt: 1,
})

it('does not lose a revocation when two processes update the state file at once', async () => {
  const path = join(await temp(), 'phone.json')
  // Each module instance has its own in-process queue, as two processes do.
  const first = await import('../extensions/phone/state.ts')
  vi.resetModules()
  const second = await import('../extensions/phone/state.ts')
  expect(second.updateState).not.toBe(first.updateState)
  await first.updateState(path, (state) => void state.devices.push(device('stolen')))

  await Promise.all([
    first.updateState(path, (state) => {
      state.devices = state.devices.filter((entry) => entry.id !== 'stolen')
    }),
    ...Array.from({ length: 10 }, (_, i) =>
      (i % 2 ? first : second).updateState(path, (state) => {
        // A stale writer would put back what it read before the revocation.
        state.devices.push(device(`new${i}`))
      }),
    ),
  ])

  const ids = (await loadState(path)).devices.map((entry) => entry.id)
  expect(ids).not.toContain('stolen')
  expect(ids.toSorted()).toEqual(Array.from({ length: 10 }, (_, i) => `new${i}`).toSorted())
})

it('breaks a lock left behind by a dead process', async () => {
  const path = join(await temp(), 'phone.json')
  const { updateState } = await import('../extensions/phone/state.ts')
  const { open, utimes } = await import('node:fs/promises')
  await (await open(`${path}.lock`, 'wx')).close()
  await utimes(`${path}.lock`, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
  await updateState(path, (state) => void state.devices.push(device('a')))
  expect((await loadState(path)).devices).toHaveLength(1)
})
