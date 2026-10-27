import type { Cursor, EntryRecord, LiveState } from '@earendil-works/pi-durable'
import type { Message } from '../extensions/messages/api.ts'
import type { VoiceLiveService } from '../extensions/voice-live/api.ts'
import type { FeedSource } from '../extensions/phone/feed.ts'

/** A Voice service that records what the phone said. */
export function fakeVoice() {
  const calls: { open: string[]; heard: [string, string][] } = { open: [], heard: [] }
  const voice: VoiceLiveService = {
    open: async (session) => {
      calls.open.push(session)
      return 7
    },
    heard: async (text, id) => {
      calls.heard.push([text, id])
    },
    conversation: async () => 7,
  }
  return { voice, calls }
}

/**
 * The feed's sources in memory: Voice's transcript entries (two to a page), @ultimate's live state and the Messages log.
 * Each change notifies watchers like the harness would.
 */
export class FakeSource implements FeedSource {
  voice: number | undefined = 7
  entries: EntryRecord[] = []
  live: LiveState | undefined
  log: Message[] = []
  #next = 100
  /** How many feeds are watching. */
  get watchers() {
    return this.#listeners.size
  }
  #listeners = new Set<(what: 'transcript' | 'other') => void>()

  conversation = async () => this.voice
  page = async (_voice: number, cursor?: Cursor) => {
    const end = cursor === undefined ? this.entries.length : (cursor as unknown as number)
    const start = Math.max(0, end - 2)
    return {
      items: this.entries.slice(start, end).toReversed(),
      ...(start > 0 && { next: start as unknown as Cursor }),
    }
  }
  ultimate = async () => ({ id: 1, live: this.live })
  messages = async () => this.log
  watch = (listener: (what: 'transcript' | 'other') => void) => {
    this.#listeners.add(listener)
    return () => void this.#listeners.delete(listener)
  }
  notify(what: 'transcript' | 'other') {
    for (const listener of this.#listeners) listener(what)
  }

  /** Append an entry of Voice's transcript; `at` makes it a message with that time. */
  add(kind: string, data: object, at?: number) {
    const id = (this.#next += 10)
    this.entries.push({
      id,
      conversationId: this.voice,
      kind,
      data,
      ...(at !== undefined && { model: [{ role: 'user', content: 'x', timestamp: at }] }),
    } as unknown as EntryRecord)
    this.notify('transcript')
    return id
  }
}
