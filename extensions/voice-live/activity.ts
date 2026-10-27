/**
 * What the sidebar and @ultimate's conversation show of Voice: the current session's counts, recomputed from Voice's
 * transcript whenever it changes, and each line copied into @ultimate while the inline setting is on.
 */
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, Cursor, EntryRecord, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Standing } from '../subagents/api.ts'
import { ActivityDoc } from './refs.ts'
import { INLINE_KEY } from './inline.ts'
import type {
  VoiceActivity,
  VoiceAnswer,
  VoiceEcho,
  VoiceHeard,
  VoiceLine,
  VoiceSession,
} from './refs.ts'

/** Quiet this long, the next line starts a new session. */
export const SESSION_GAP = 30 * 60_000

export const Activity = defineDoc<VoiceActivity>({
  kind: ActivityDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ messages: 0, relayed: 0, waiting: 0 }),
})

/**
 * The session of Voice conversation `id`, newest line first, back to the first gap of `SESSION_GAP` or a line written
 * before lines carried their time. Pure over the transcript, so recomputing it is always safe.
 */
export async function activityOf(tx: Tx, id: ConversationId): Promise<VoiceActivity> {
  const activity: VoiceActivity = { messages: 0, relayed: 0, waiting: 0 }
  const settled = new Set<number>()
  let cursor: Cursor | undefined
  do {
    const page = await tx.scanEntries({ conversationId: id, order: 'descending' }, 100, cursor)
    for (const entry of page.items) {
      if (entry.kind === 'voice.answer') settled.add((entry.data as VoiceAnswer).re)
      const line = entry.kind === 'voice.line' ? (entry.data as VoiceLine) : undefined
      if (line?.role === 'notice' && line.re !== undefined) settled.add(line.re)
      const counted =
        entry.kind === 'voice.heard' ||
        entry.kind === 'voice.session' ||
        (line && ((line.role === 'user' && line.forwarded) || line.role === 'ultimate'))
      if (!counted) continue
      const at = (entry.data as { at?: number }).at
      if (at === undefined || (activity.since !== undefined && activity.since - at > SESSION_GAP))
        return activity
      if (entry.kind === 'voice.session' && (entry.data as VoiceSession).phase === 'ended') continue
      activity.since = at
      activity.at ??= at
      // Spoken lines go back the way the user came in: the newest heard line or session says which.
      if (!line)
        activity.via ??=
          (entry.data as VoiceHeard | VoiceSession).via === 'phone' ? 'phone' : 'browser'
      if (entry.kind === 'voice.heard' || line?.role === 'ultimate') activity.messages++
      else if (line) {
        activity.relayed++
        if (!settled.has(entry.id)) activity.waiting++
      }
    }
    cursor = page.next
  } while (cursor)
  return activity
}

/** The copy of a Voice line @ultimate's conversation shows, or undefined for lines it leaves out. */
export function echoOf(entry: EntryRecord): VoiceEcho | undefined {
  const source = { conversation: entry.conversationId, entry: entry.id }
  if (entry.kind === 'voice.heard') {
    const heard = entry.data as VoiceHeard
    return {
      role: 'user',
      text: heard.text,
      source,
      ...(heard.at ? { at: heard.at } : {}),
      ...(heard.via ? { via: heard.via } : {}),
    }
  }
  if (entry.kind !== 'voice.line') return undefined
  const line = entry.data as VoiceLine
  // Forwarded lines already reach @ultimate as its input; notes and GPT-Live's backchannels are not part of the talk.
  if (line.role !== 'ultimate' && line.role !== 'notice') return undefined
  return {
    role: line.role === 'ultimate' ? 'voice' : 'notice',
    text: line.text,
    source,
    ...(line.at ? { at: line.at } : {}),
    ...(line.lookup ? { lookup: true as const } : {}),
    ...(line.re !== undefined ? { relayed: true as const } : {}),
  }
}

/**
 * Keep Voice's activity document current and copy its new lines into @ultimate while the inline setting is on. Each
 * copy's request id names its line, so a line is copied once. Returns the unsubscribe.
 */
export function watchActivity(host: ExtensionHost) {
  let chain: Promise<unknown> = Promise.resolve()
  let ids: Record<string, ConversationId> | undefined
  const load = async () => {
    ids = await host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, context)
  }
  const refresh = (id: ConversationId) =>
    host.harness().commit(async (tx) => {
      Object.assign(await tx.doc(Activity, id), await activityOf(tx, id))
    }, context)
  const echo = async (entry: EntryRecord, main: ConversationId) => {
    const data = echoOf(entry)
    if (!data || (await host.uiState(context))[INLINE_KEY] !== true) return
    await (
      await host.harness().conversation(main, context)
    )?.submit(
      {
        type: 'write',
        requestId: `voice:echo:${entry.id}`,
        entry: { kind: 'voice.echo', data },
      },
      context,
    )
  }
  const run = (work: () => Promise<unknown>) => {
    chain = chain.then(work).catch((error: unknown) => console.error('Voice activity:', error))
  }
  run(async () => {
    await load()
    if (ids?.voice !== undefined) await refresh(ids.voice)
  })
  return host.harness().subscribeCommits((publication) => {
    // Voice's conversation may be created in this very commit: then its entries are told apart after the reload.
    const reload = publication.changes.some(
      (change) => change.type === 'document' && change.record.kind === Standing.definition.kind,
    )
    const entries = publication.changes.flatMap((change) =>
      change.type === 'entry' && (reload || change.value.conversationId === ids?.voice)
        ? [change.value]
        : [],
    )
    if (entries.length === 0) return
    run(async () => {
      if (reload) await load()
      const voice = ids?.voice
      const mine = entries.filter((entry) => entry.conversationId === voice)
      if (voice === undefined || mine.length === 0) return
      await refresh(voice)
      const main = ids?.ultimate
      if (main !== undefined) for (const entry of mine) await echo(entry, main)
    })
  })
}
