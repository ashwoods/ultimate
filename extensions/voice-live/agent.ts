/** Which standing agent is the relay: `voice`, or the resident agent that replaces it. */
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { discoverAgents } from '../../lib/agents.ts'
import { Standing } from '../subagents/api.ts'
import { RelayDoc } from './refs.ts'

type Host = Pick<ExtensionHost, 'ultimateRoot' | 'projectRoot' | 'userHome' | 'modelRuntime'>

/** The resident agent that replaces Voice (`formerly: [voice]`, as an extension's agent built on it does), else `voice`. */
async function discover(host: Host) {
  const { definitions } = await discoverAgents(
    host.ultimateRoot,
    host.projectRoot,
    host.userHome,
    host.modelRuntime,
  )
  return (
    definitions.find(
      (definition) => definition.resident === true && definition.formerly?.includes('voice'),
    )?.name ?? 'voice'
  )
}

const names = new WeakMap<object, Promise<string>>()
/**
 * The relay agent's name, discovered once per install, so the request hook stays cheap, and again (`fresh`) when a
 * session starts, which also picks up an agent added since.
 */
export function relayName(host: Host, fresh = false) {
  let name = names.get(host)
  if (!name || fresh) {
    name = discover(host)
    names.set(host, name)
  }
  return name
}

/** The relay's conversation, once it exists. */
export async function relayId(host: ExtensionHost) {
  const standing = await host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, context)
  return standing?.[await relayName(host)]
}

/** On the root conversation: the relay agent's name, for the browser. */
export const Relay = defineDoc<{ name?: string }>({
  kind: RelayDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})

/** Discover the name afresh, record it for the browser and return it. */
export async function freshRelayName(host: ExtensionHost) {
  const name = await relayName(host, true)
  await host.harness().commit(async (tx) => {
    const doc = await tx.doc(Relay, ROOT_CONVERSATION_ID)
    if (doc.name !== name) doc.name = name
  }, context)
  return name
}
