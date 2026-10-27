import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { browserBinary } from '../extensions/browser/server.ts'

const cache = join(homedir(), 'Library/Caches/ms-playwright')
const chromium = join(cache, 'chromium-1134/chrome-mac/Chromium.app/Contents/MacOS/Chromium')

// A Mac with only Playwright's Chromium: no system browser, no Linux cache.
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  const missing = (path: unknown) =>
    Promise.reject(Object.assign(new Error(`ENOENT: ${String(path)}`), { code: 'ENOENT' }))
  return {
    ...fs,
    readdir: (path: string) =>
      path === cache ? Promise.resolve(['chromium-1134', 'ffmpeg-1010']) : missing(path),
    access: (path: string) => (path === chromium ? Promise.resolve() : missing(path)),
  }
})

it("finds Playwright's Chromium in the macOS cache", async () => {
  vi.stubEnv('ULTIMATE_CHROMIUM', '')
  expect(await browserBinary()).toBe(chromium)
})
