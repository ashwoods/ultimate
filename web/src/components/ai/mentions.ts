/**
 * `#157029` and `#157029/158003` in running text: a conversation, and an entry in it. Never part of a word, a path, a
 * URL fragment or an HTML entity; ids under three digits stay text, since `#1 priority` or `#12` is usually not a
 * conversation. `message 74` is a message on the board, by its id.
 */
export const mentionPattern =
  /(?<![\w/#&])#(\d{3,})(?:\/(\d+))?(?![\w/])|(?<![\w-])[Mm]essage (\d+)(?![\w/])/g

/**
 * The link a mention becomes in Markdown; the conversations extension's `link` renderer turns it into a chip. A bare
 * fragment, since Streamdown's hardening blocks other relative links, and no other link renderer reads one.
 */
export const mentionHref = (conversation: string, entry?: string) =>
  `#conversation-${conversation}${entry ? `-${entry}` : ''}`

/** The link a `message 74` mention becomes; the messages extension's `link` renderer opens its card. */
export const messageHref = (message: string) => `#message-${message}`

/** A mention link's conversation and entry, or undefined for any other href. */
export function parseMention(href: string) {
  const match = /^#conversation-(\d+)(?:-(\d+))?$/.exec(href)
  return match
    ? { conversation: Number(match[1]), entry: match[2] ? Number(match[2]) : undefined }
    : undefined
}

/** A message mention link's board message id, or undefined for any other href. */
export function parseMessageMention(href: string) {
  const match = /^#message-(\d+)$/.exec(href)
  return match ? Number(match[1]) : undefined
}

/** Splits text into strings and mentions with the link each becomes, in order. */
export function splitMentions(text: string) {
  const parts: (string | { href: string; text: string })[] = []
  let last = 0
  for (const match of text.matchAll(mentionPattern)) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    const href = match[3] ? messageHref(match[3]) : mentionHref(match[1], match[2])
    parts.push({ href, text: match[0] })
    last = match.index + match[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

type Node = { type: string; value?: string; children?: Node[]; url?: string }

/**
 * Remark plugin: mentions in text become links to their href. Code, inline code and existing links keep their text,
 * since only plain `text` nodes outside links are rewritten.
 */
export function remarkMentions() {
  const visit = (node: Node) => {
    if (!node.children || node.type === 'link' || node.type === 'linkReference') return
    node.children = node.children.flatMap((child) => {
      if (child.type !== 'text' || !child.value || !/#|essage /.test(child.value)) {
        visit(child)
        return [child]
      }
      return splitMentions(child.value).map((part) =>
        typeof part === 'string'
          ? { type: 'text', value: part }
          : { type: 'link', url: part.href, children: [{ type: 'text', value: part.text }] },
      )
    })
  }
  return visit
}
