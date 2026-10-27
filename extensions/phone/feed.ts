/**
 * The phone's live feed (ultimate-ios `docs/protocol.md`, FeedItem), derived from Voice's transcript, @ultimate's live
 * state and the Messages log. `buildItems` and `phaseOf` are pure; `createFeed` keeps the current items and tells
 * subscribers what changed; `harnessSource` reads them from the harness.
 */
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { LiveDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type {
  ConversationId,
  Cursor,
  EntryRecord,
  LiveState,
  ToolSlot,
} from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Messages } from '../messages/api.ts'
import type { Message } from '../messages/api.ts'
import { Standing } from '../subagents/api.ts'
import type { VoiceAnswer, VoiceHeard, VoiceLine } from '../voice-live/refs.ts'
import type { VoiceLiveService } from '../voice-live/api.ts'

export type FeedItem =
  | { kind: 'heard'; id: number; at: number; text: string }
  | { kind: 'said'; id: number; at: number; text: string }
  | {
      kind: 'job'
      id: number
      at: number
      request: string
      state: 'working' | 'answered' | 'failed'
      phase?: string
      speech?: string
      summary?: string
      detail?: string
      question?: number
    }
export type JobItem = Extract<FeedItem, { kind: 'job' }>

/** The newest items kept, and the most a phone can ask for. */
export const MAX_ITEMS = 200
const PHASE_EVERY = 1000

const TOOL_PHASES: Record<string, string> = {
  bash: 'Running a command',
  read: 'Reading files',
  edit: 'Editing',
  write: 'Editing',
  codemode: 'Looking things up',
  branch: 'Starting a branch',
  subagent: 'Delegating',
  message: 'Writing',
}

/** What @ultimate is doing, in a few words; undefined while it is not working. */
export function phaseOf(live: Pick<LiveState, 'run' | 'tools'> | undefined) {
  if (!live?.run) return undefined
  const tool: ToolSlot | undefined =
    live.tools?.find((slot) => slot.status === 'running') ??
    live.tools?.find((slot) => slot.status === 'pending')
  return tool ? (TOOL_PHASES[tool.name] ?? tool.name) : 'Thinking'
}

const isItem = (entry: EntryRecord) => {
  if (entry.kind === 'voice.heard') return true
  if (entry.kind !== 'voice.line') return false
  const line = entry.data as VoiceLine
  return (
    (line.role === 'user' && line.forwarded) ||
    (line.role === 'ultimate' && line.speech && line.re === undefined)
  )
}

/** Items from Voice's transcript entries, oldest first. Times come from the entry's message, else the entry before. */
export function buildItems(entries: readonly EntryRecord[]): FeedItem[] {
  const items = new Map<number, FeedItem>()
  const failures = new Map<number, string>()
  let stamp = 0
  for (const entry of entries) {
    stamp = entry.model?.[0]?.timestamp ?? stamp
    if (entry.kind === 'voice.heard') {
      items.set(entry.id, {
        kind: 'heard',
        id: entry.id,
        at: stamp,
        text: (entry.data as VoiceHeard).text,
      })
    } else if (entry.kind === 'voice.line') {
      const line = entry.data as VoiceLine
      const job = line.re === undefined ? undefined : items.get(line.re)
      if (line.role === 'user' && line.forwarded)
        items.set(entry.id, {
          kind: 'job',
          id: entry.id,
          at: line.at ?? stamp,
          request: line.text,
          state: 'working',
        })
      else if (line.role === 'ultimate' && line.speech && line.re === undefined)
        items.set(entry.id, { kind: 'said', id: entry.id, at: stamp, text: line.text })
      else if (line.role === 'ultimate' && line.speech && job?.kind === 'job') {
        job.speech = line.text
        if (line.summary) job.summary = line.summary
      } else if (line.role === 'notice' && line.re !== undefined) failures.set(line.re, line.text)
    } else if (entry.kind === 'voice.answer') {
      const answer = entry.data as VoiceAnswer
      const job = items.get(answer.re)
      if (job?.kind === 'job') {
        job.state = 'answered'
        job.detail = answer.text
      }
    }
  }
  for (const [id, text] of failures) {
    const job = items.get(id)
    if (job?.kind === 'job') {
      job.state = 'failed'
      job.summary = text.slice(0, 140)
      // Voice is told "Ultimate did not answer that request" as if it were an answer; it is not one.
      delete job.detail
    }
  }
  return [...items.values()]
}

/** The items with the current phase on working jobs, and the open question on the job it was asked during. */
function decorate(
  items: readonly FeedItem[],
  phase: string | undefined,
  question: Message | undefined,
): FeedItem[] {
  const owner = question && items.findLast((item) => item.kind === 'job' && item.at <= question.at)
  return items.map((item) => {
    if (item.kind !== 'job') return item
    const decorated = { ...item }
    if (item.state === 'working' && phase) decorated.phase = phase
    if (question && item === owner) decorated.question = question.id
    return decorated
  })
}

/** Where the feed reads from: the harness in the server, a fake in tests. */
export type FeedSource = {
  /** Voice's conversation id, once it exists. */
  conversation(): Promise<number | undefined>
  /** A page of Voice's entries, newest first. */
  page(voice: number, cursor?: Cursor): Promise<{ items: readonly EntryRecord[]; next?: Cursor }>
  /** @ultimate's conversation and its live state. */
  ultimate(): Promise<{ id: number; live?: LiveState } | undefined>
  messages(): Promise<readonly Message[]>
  /** `transcript`: Voice has new entries or a different conversation; `other`: @ultimate's phase or the Messages log changed. */
  watch(listener: (what: 'transcript' | 'other') => void): () => void
}

/** Entries from the newest back to the `limit`th item, and one message further so its time is known. */
async function scan(source: FeedSource, voice: number, limit: number) {
  const found: EntryRecord[] = []
  let count = 0
  let cursor: Cursor | undefined
  do {
    const page = await source.page(voice, cursor)
    for (const entry of page.items) {
      found.push(entry)
      if (isItem(entry)) count++
      if (count >= limit && entry.model?.[0]?.timestamp !== undefined) return found.toReversed()
    }
    cursor = page.next
  } while (cursor !== undefined)
  return found.toReversed()
}

const withoutPhase = (item: FeedItem) => JSON.stringify({ ...item, phase: undefined })

export type FeedOptions = {
  now?: () => number
  /** Run `callback` after `ms`; returns the cancel. */
  later?: (ms: number, callback: () => void) => () => void
  notice?: (message: string) => void
}

export function createFeed(source: FeedSource, options: FeedOptions = {}) {
  const now = options.now ?? Date.now
  const notice = options.notice ?? (() => {})
  const later =
    options.later ??
    ((ms, callback) => {
      const timer = setTimeout(callback, ms)
      timer.unref()
      return () => clearTimeout(timer)
    })
  const subscribers = new Set<(items: FeedItem[]) => void>()
  const observers = new Set<(items: FeedItem[]) => void | Promise<void>>()
  /** What subscribers have been told. */
  let current = new Map<number, FeedItem>()
  let transcript: FeedItem[] = []
  let voice: number | undefined
  let dirty = true
  let lastPhaseEvent = -Infinity
  let unwatch: (() => void) | undefined
  let running: Promise<void> | undefined
  let again = false
  let timer: { at: number; cancel: () => void } | undefined

  async function pass() {
    const id = await source.conversation()
    if (id === undefined) transcript = []
    else if (dirty || id !== voice) {
      dirty = false
      try {
        transcript = buildItems(await scan(source, id, MAX_ITEMS)).slice(-MAX_ITEMS)
      } catch (error) {
        dirty = true
        throw error
      }
    }
    voice = id
    const hasJobs = transcript.some((item) => item.kind === 'job')
    const ultimate = hasJobs ? await source.ultimate() : undefined
    const question = ultimate
      ? (await source.messages()).findLast(
          (m) => m.from === ultimate.id && m.to === 'user' && m.reply && m.state === 'delivered',
        )
      : undefined
    const next = decorate(transcript, phaseOf(ultimate?.live), question)

    const t = now()
    const told = new Map<number, FeedItem>()
    const changed: FeedItem[] = []
    let held = false
    for (const item of next) {
      const before = current.get(item.id)
      const same = before && JSON.stringify(before) === JSON.stringify(item)
      if (same) told.set(item.id, before)
      else if (
        before &&
        withoutPhase(before) === withoutPhase(item) &&
        t - lastPhaseEvent < PHASE_EVERY
      ) {
        told.set(item.id, before)
        held = true
      } else {
        if (before && withoutPhase(before) === withoutPhase(item)) lastPhaseEvent = t
        told.set(item.id, item)
        changed.push(item)
      }
    }
    current = told
    if (held) wake(lastPhaseEvent + PHASE_EVERY)
    if (changed.length) for (const emit of subscribers) emit(changed)
    for (const observe of observers)
      Promise.resolve(observe(next)).catch((error: unknown) => notice(`Phone: ${String(error)}`))
  }

  /** Refresh once more, after the pass in progress if there is one; resolves when that pass is done. */
  function refresh() {
    if (running) {
      again = true
      return running
    }
    running = (async () => {
      do {
        again = false
        await pass()
      } while (again)
    })().finally(() => (running = undefined))
    return running
  }

  /** Refresh no later than `at` (ms epoch); an earlier wake that is already waiting stays. */
  function wake(at: number) {
    if (timer && timer.at <= at) return
    timer?.cancel()
    const cancel = later(Math.max(0, at - now()), () => {
      timer = undefined
      refresh().catch((error: unknown) => notice(`Phone: ${String(error)}`))
    })
    timer = { at, cancel }
  }

  return {
    /** Follow the sources until `stop`. */
    start() {
      if (unwatch) return
      unwatch = source.watch((what) => {
        if (what === 'transcript') dirty = true
        refresh().catch((error: unknown) => notice(`Phone: ${String(error)}`))
      })
      refresh().catch((error: unknown) => notice(`Phone: ${String(error)}`))
    },
    stop() {
      unwatch?.()
      unwatch = undefined
      timer?.cancel()
      timer = undefined
    },
    refresh,
    wake,
    /** The newest `limit` items as they are now, and `emit` for every change from then on; `leave` ends it. */
    async join(limit: number, emit: (items: FeedItem[]) => void) {
      await refresh()
      subscribers.add(emit)
      return {
        items: [...current.values()].slice(-limit),
        leave: () => void subscribers.delete(emit),
      }
    },
    /** Called with every item after each refresh, changed or not. */
    observe(listener: (items: FeedItem[]) => void | Promise<void>) {
      observers.add(listener)
    },
  }
}
export type Feed = ReturnType<typeof createFeed>

/** The feed's sources in this server: Voice's conversation, @ultimate's, and the Messages log. */
export function harnessSource(
  host: Pick<ExtensionHost, 'harness'>,
  voice: Pick<VoiceLiveService, 'conversation'>,
): FeedSource {
  const ids: { voice?: number; ultimate?: number; phase?: string } = {}
  return {
    async conversation() {
      return (ids.voice = await voice.conversation())
    },
    page: (id, cursor) =>
      host
        .harness()
        .commit(
          (tx) =>
            tx.scanEntries(
              { conversationId: id as ConversationId, order: 'descending' },
              100,
              cursor,
            ),
          context,
        ),
    async ultimate() {
      const id = (await host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, context))?.ultimate
      ids.ultimate = id
      if (id === undefined) return undefined
      const live = await host.harness().snapshot(LiveDoc, id, context)
      ids.phase = phaseOf(live)
      return { id, live }
    },
    async messages() {
      return (
        (await host.harness().snapshot(Messages, ROOT_CONVERSATION_ID, context))?.messages ?? []
      )
    },
    watch: (listener) =>
      host.harness().subscribeCommits((publication) => {
        for (const change of publication.changes) {
          if (change.type === 'entry') {
            if (change.value.conversationId === ids.voice) listener('transcript')
          } else if (
            change.type === 'document' &&
            change.record.kind === Standing.definition.kind
          ) {
            listener('transcript')
          } else if (
            change.type === 'document' &&
            change.record.kind === Messages.definition.kind
          ) {
            listener('other')
          } else if (
            change.type === 'document' &&
            change.record.kind === LiveDoc.definition.kind &&
            change.conversationId === ids.ultimate &&
            // The live document also carries the streaming partial of every generation; only its phase matters here.
            phaseOf(change.value ?? undefined) !== ids.phase
          ) {
            listener('other')
          }
        }
      }),
  }
}
