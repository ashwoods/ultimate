/** The sidebar's points for other extensions' browser code. */
import type { ReactNode } from 'react'
import { definePoint } from '@/sdk'

export { StandingRow } from './rows.tsx'

/**
 * Rows nested under @ultimate's row (`side-chat` lists its open side chats, `voice-live` the relay's); several extensions may provide it and
 * their rows show in discovery order. Input is @ultimate's conversation id.
 */
export const UnderUltimate = definePoint<number | undefined, ReactNode>('sidebar.under-ultimate')
/**
 * A standing agent's own block between @ultimate's and the Agents group, each under its own rule (an extension's own
 * agent, built from `StandingRow`); several extensions may provide it. Input is @ultimate's conversation id.
 */
export const BelowUltimate = definePoint<number | undefined, ReactNode>('sidebar.below-ultimate')
/**
 * Top-level conversations no section lists (`side-chat` names its side chats, open or ended, `voice-live` its relay's
 * conversation, which nests under @ultimate or has its own block); several extensions may provide it and the sidebar takes the union.
 * Input is @ultimate's conversation id.
 */
export const Unlisted = definePoint<number | undefined, ReadonlySet<number>>('sidebar.unlisted')
