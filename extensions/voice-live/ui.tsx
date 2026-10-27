/** Live voice for other extensions' browser code: the relay's name and conversation, the session mode and points. */
import { useSyncExternalStore } from 'react'
import { definePoint, useDocOf } from '@/sdk'
import type { UltimateActions } from '@/sdk'
import { StandingDoc, talkToUltimate } from '../subagents/ui.tsx'
import * as live from './live.tsx'
import { RelayDoc } from './refs.ts'

export { ActivityDoc, RelayDoc } from './refs.ts'
export type { VoiceActivity, VoiceHeard, VoiceLine } from './refs.ts'
export type { VoiceMode } from './live.tsx'

/**
 * Whether an extension shows the relay's conversation in the sidebar itself (`true`), so voice-live leaves out its own
 * row under @ultimate. Input is the relay's conversation id.
 */
export const OwnRow = definePoint<number, boolean>('voice-live.own-row')

/** This page's voice session: off, starting, live, paused or ending, muted, in front, an answer waiting. */
export const useVoiceMode = () => useSyncExternalStore(live.subscribe, live.voiceMode)

/** The relay agent's name: `voice` unless the user's settings name another. */
export const useRelayName = () => useDocOf(1, RelayDoc)?.name ?? 'voice'

/** @ultimate's conversation and the relay's, once it exists. */
export function useRelayIds() {
  const name = useRelayName()
  const standing = useDocOf(1, StandingDoc)
  return { main: standing?.ultimate, voice: standing?.[name] }
}

/** The relay to the front over @ultimate, from anywhere, or back. */
export function toggleFront(actions: Pick<UltimateActions, 'switchConversation' | 'showSurface'>) {
  const front = !live.voiceMode().front
  live.setFront(front)
  // oxlint-disable-next-line typescript/no-floating-promises -- an uncaught action failure becomes a notice.
  if (front) void talkToUltimate(actions)
}
