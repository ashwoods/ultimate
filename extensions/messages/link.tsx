import { MessageCircleQuestionIcon, MessageSquareIcon } from 'lucide-react'
import type { MouseEvent, ReactNode } from 'react'
import { parseMessageMention } from '@/components/ai/mentions'
import { cn, events, useDocOf, useUltimate } from '@/sdk'
import { emptyMessages } from './data.tsx'
import { MessagesDoc } from './refs.ts'
import type { Message } from './refs.ts'

/** Where message `id` sits: the conversation that sent it and the tool call it went out with; none for unknown ids. */
export function messageTarget(messages: readonly Message[], id: number) {
  const message = messages.find((item) => item.id === id)
  if (!message || typeof message.from !== 'number' || !message.call) return undefined
  const open = message.to === 'user' && message.reply && message.state === 'delivered'
  return { conversation: message.from, call: message.call, open }
}

/**
 * A `message 74` mention as a quiet link in the mention chips' style: it opens the sender's conversation at that
 * message's card and highlights it. A message this board does not know stays its text.
 */
export function MessageLink({
  href,
  children,
  core,
}: {
  href: string
  children: ReactNode
  core: ReactNode
}) {
  const id = parseMessageMention(href)
  const { switchConversation, showSurface } = useUltimate()
  const log = useDocOf(1, MessagesDoc) ?? emptyMessages
  const target = id === undefined ? undefined : messageTarget(log.messages, id)
  if (id === undefined || !target) return core
  const open = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    events.emit('messages:open', {
      conversation: target.conversation,
      call: target.call,
      message: id,
    })
    showSurface('agent')
    switchConversation(target.conversation)
  }
  const Icon = target.open ? MessageCircleQuestionIcon : MessageSquareIcon
  return (
    <a
      className="inline-flex items-center gap-1 rounded-sm px-0.5 align-bottom font-mono text-[11.5px] leading-5 text-foreground no-underline transition-colors hover:bg-accent"
      data-message-mention={id}
      href={`?conversation=${target.conversation}`}
      onClick={open}
      title={`Open message ${id} in #${target.conversation}`}
    >
      <Icon
        className={cn(
          'size-3 shrink-0',
          target.open ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground/70',
        )}
      />
      {children}
    </a>
  )
}
