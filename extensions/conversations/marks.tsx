import { BotIcon, BrainIcon, GitMergeIcon, ScrollTextIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { AllProvided, cn, definePoint } from '@/sdk'

/** The display names of the agents Ultimate ships with; any other standing agent is its name, capitalised. */
const names: Record<string, string> = {
  ultimate: 'Ultimate',
  lander: 'Lander',
}
export const agentTitle = (name: string) =>
  names[name] ?? name.charAt(0).toUpperCase() + name.slice(1)

/**
 * An agent's tile: its tint and glyph, and optionally the text colour of a letter-spaced wordmark the sidebar shows
 * instead of its name. Glyphs size to the tile through `size-[60%]`.
 */
export type AgentTile = { tint: string; glyph: ReactNode; wordmark?: string }
/**
 * The tile an extension gives the standing agent it brings, by agent name (`voice-live` gives its relay one); undefined
 * for other names. Ultimate's own agents keep theirs.
 */
export const AgentTiles = definePoint<string, AgentTile | undefined>('conversations.agent-tile')

/** Each known agent's tile. */
const tiles: Record<string, AgentTile> = {
  ultimate: {
    tint: 'bg-brand/12 text-brand ring-brand/25',
    // The top bar's wordmark, reduced to its first letter.
    glyph: <span className="font-sans leading-none font-semibold">U</span>,
    wordmark: 'text-brand',
  },
  lander: {
    tint: 'bg-success/10 text-success ring-success/25',
    glyph: <GitMergeIcon className="size-[60%]" strokeWidth={2.25} />,
  },
  root: {
    tint: 'bg-brand/8 text-brand/90 ring-brand/20',
    glyph: <ScrollTextIcon className="size-[58%]" strokeWidth={2} />,
  },
  memory: {
    tint: 'bg-brand/8 text-brand/90 ring-brand/20',
    glyph: <BrainIcon className="size-[58%]" strokeWidth={2} />,
  },
}
const fallback = {
  tint: 'bg-muted text-muted-foreground ring-border',
  glyph: <BotIcon className="size-[60%]" strokeWidth={2} />,
}

/** Renders with `name`'s tile: Ultimate's own, else the one an extension gives it, else a bot. */
export function WithAgentTile({
  name,
  children,
}: {
  name: string
  children: (tile: AgentTile) => ReactNode
}) {
  const own = tiles[name]
  if (own) return children(own)
  return (
    <AllProvided input={name} point={AgentTiles}>
      {(found) => children(found.find((tile) => tile !== undefined) ?? fallback)}
    </AllProvided>
  )
}

/** The presence dot in a mark's corner: pulsing while it works, amber while it waits on you, else muted. */
export type Presence = 'working' | 'waiting' | 'idle'

/**
 * An agent's avatar: a small rounded tile in its colour with its glyph, the same in the sidebar, the title bar and
 * chat headers. `name` is a standing agent's name, `lander`, `root` for a project's context or `memory` for its memory.
 */
export function AgentMark({
  name,
  size = 'md',
  presence,
}: {
  name: string
  size?: 'xs' | 'sm' | 'md'
  presence?: Presence
}) {
  return (
    <WithAgentTile name={name}>
      {(tile) => <Tile name={name} presence={presence} size={size} tile={tile} />}
    </WithAgentTile>
  )
}

function Tile({
  name,
  size,
  presence,
  tile,
}: {
  name: string
  size: 'xs' | 'sm' | 'md'
  presence?: Presence
  tile: AgentTile
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center rounded-[5px] ring-1 ring-inset',
        tile.tint,
        size === 'md' && 'size-6 text-[12px]',
        size === 'sm' && 'size-4 rounded-[4px] text-[9.5px]',
        size === 'xs' && 'size-3.5 rounded-[3px] text-[8.5px]',
      )}
      data-agent-mark={name}
    >
      {tile.glyph}
      {presence && (
        <span
          className={cn(
            'absolute -right-0.5 -bottom-0.5 rounded-full ring-2 ring-sidebar',
            size === 'md' ? 'size-2' : 'size-1.5 ring-[1.5px]',
            presence === 'working'
              ? 'animate-pulse-dot bg-brand'
              : presence === 'waiting'
                ? 'bg-amber-400'
                : 'bg-muted-foreground/60',
          )}
          data-presence={presence}
        />
      )}
    </span>
  )
}
