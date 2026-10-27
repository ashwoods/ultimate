/** Live voice for other extensions' browser code. */
import { definePoint } from '@/sdk'

export { ActivityDoc, RelayDoc } from './refs.ts'
export type { VoiceActivity, VoiceHeard, VoiceLine } from './refs.ts'

/**
 * Whether an extension shows the relay's conversation in the sidebar itself (`true`), so voice-live leaves out its own
 * row under @ultimate. Input is the relay's conversation id.
 */
export const OwnRow = definePoint<number, boolean>('voice-live.own-row')
