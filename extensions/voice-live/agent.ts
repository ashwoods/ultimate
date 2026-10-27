/** Which standing agent is the relay: `voice`, or the one the user's settings name. */
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { readSettings, userSettingsPath } from '../../lib/settings.ts'
import { Standing } from '../subagents/api.ts'
import { RelayDoc } from './refs.ts'

/**
 * The relay agent's name: the user's `voiceLive.agent` setting, for an extension that brings its own agent built on
 * `voice` (`extends: voice`), else `voice`.
 */
export async function relayName(host: Pick<ExtensionHost, 'userHome'>) {
  const settings = await readSettings(userSettingsPath(host.userHome))
  const agent = (settings.voiceLive as { agent?: unknown } | undefined)?.agent
  return typeof agent === 'string' && agent ? agent : 'voice'
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

/** Record the current name for the browser. */
export async function publishRelayName(host: ExtensionHost) {
  const name = await relayName(host)
  await host.harness().commit(async (tx) => {
    const doc = await tx.doc(Relay, ROOT_CONVERSATION_ID)
    if (doc.name !== name) doc.name = name
  }, context)
}
