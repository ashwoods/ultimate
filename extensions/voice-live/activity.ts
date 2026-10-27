/** The relay's current session, for a sidebar: its counts, recomputed from its transcript whenever that changes. */
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineDoc } from '@earendil-works/pi-durable'
import type { ConversationId, Cursor, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Standing } from '../subagents/api.ts'
import { relayId } from './agent.ts'
import { ActivityDoc } from './refs.ts'
import type { VoiceActivity, VoiceAnswer, VoiceHeard, VoiceLine, VoiceSession } from './refs.ts'

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

/** Keep the relay's activity document current as its transcript changes. Returns the unsubscribe. */
export function watchActivity(host: ExtensionHost) {
  let chain: Promise<unknown> = Promise.resolve()
  let voice: ConversationId | undefined
  const load = async () => {
    voice = await relayId(host)
  }
  const refresh = (id: ConversationId) =>
    host.harness().commit(async (tx) => {
      Object.assign(await tx.doc(Activity, id), await activityOf(tx, id))
    }, context)
  const run = (work: () => Promise<unknown>) => {
    chain = chain.then(work).catch((error: unknown) => console.error('Voice activity:', error))
  }
  run(async () => {
    await load()
    if (voice !== undefined) await refresh(voice)
  })
  return host.harness().subscribeCommits((publication) => {
    // Voice's conversation may be created in this very commit: then its entries are told apart after the reload.
    const reload = publication.changes.some(
      (change) => change.type === 'document' && change.record.kind === Standing.definition.kind,
    )
    const conversations = new Set(
      publication.changes.flatMap((change) =>
        change.type === 'entry' && (reload || change.value.conversationId === voice)
          ? [change.value.conversationId]
          : [],
      ),
    )
    if (conversations.size === 0) return
    run(async () => {
      if (reload) await load()
      if (voice !== undefined && conversations.has(voice)) await refresh(voice)
    })
  })
}
