import { defineExtension } from '@earendil-works/pi-durable'
import { implementAction } from '../../lib/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { VoiceLiveApi } from '../voice-live/api.ts'
import { harnessSource } from './feed.ts'
import { createPhone } from './runtime.ts'
import {
  PairAllowAction,
  PairCancelAction,
  PairDenyAction,
  PairStartAction,
  RevokeAction,
  StatusAction,
} from './refs.ts'

export const secrets = [
  {
    name: 'ULTIMATE_PHONE_RELAY_TOKEN',
    description: 'Deploy token of your phone relay, for the Ultimate phone app',
  },
  {
    name: 'ELEVENLABS_API_KEY',
    description:
      'ElevenLabs API key; the phone app speaks answers with a single-use token minted from it',
    url: 'https://elevenlabs.io/app/settings/api-keys',
  },
  {
    name: 'APNS_AUTH_KEY',
    description:
      'Apple push key (.p8 file contents) the Mac signs notifications for the phone app with',
    url: 'https://developer.apple.com/account/resources/authkeys/list',
  },
]
/** All user-only: pairing and forgetting phones are the user's decisions, and the status carries the pairing code. */
export const userActions = ['status', 'pairStart', 'pairCancel', 'pairAllow', 'pairDeny', 'revoke']

const phones = new WeakMap<ExtensionHost, ReturnType<typeof createPhone>>()
const phoneOf = (host: ExtensionHost) => phones.get(host)!
const device = (args: unknown) => {
  const value = args && typeof args === 'object' && 'device' in args ? args.device : undefined
  if (typeof value !== 'string' || !value) throw new Error('device is required')
  return value
}

export const actions = {
  status: implementAction(StatusAction, (_args, { host }) => phoneOf(host).status()),
  pairStart: implementAction(PairStartAction, (_args, { host }) => phoneOf(host).pairStart()),
  pairCancel: implementAction(PairCancelAction, (_args, { host }) => phoneOf(host).pairCancel()),
  pairAllow: implementAction(PairAllowAction, (args, { host }) =>
    phoneOf(host).pairAllow(device(args)),
  ),
  pairDeny: implementAction(PairDenyAction, (args, { host }) =>
    phoneOf(host).pairDeny(device(args)),
  ),
  revoke: implementAction(RevokeAction, (args, { host }) => phoneOf(host).revoke(device(args))),
}

/** Serves paired phones through the user's relay. Off by default and inert until `phone.relay` and its token are set. */
export default function phone(host: ExtensionHost) {
  const voice = host.need(VoiceLiveApi)
  const service = createPhone(host, { voice, source: harnessSource(host, voice) })
  phones.set(host, service)
  host.onOpen(service.start)
  host.onRelease(async () => service.release())
  host.onClose(async () => service.stop())
  return defineExtension({ name: 'phone' })
}
