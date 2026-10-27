/** The Mac side of the phone app in the browser: connection status, pairing a phone, forgetting one. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'

export type PhoneStatus = {
  /** `off`: a preview instance without `ULTIMATE_PHONE_RELAY`; `unconfigured`: `error` says what is missing. */
  state: 'off' | 'unconfigured' | 'connecting' | 'online' | 'error'
  error?: string
  relay?: string
  /** The Mac's name as the phone shows it, once the state file exists. */
  name?: string
  /** With `unconfigured`: the setting that is missing or invalid, `relay` (`phone.relay`) or `token` (`ULTIMATE_PHONE_RELAY_TOKEN`). */
  missing?: 'relay' | 'token'
  /** This project's instance id on the relay. */
  instance: string
  /** Whether this Mac can send the phone notifications: `error` says what is missing. */
  push?: { configured: true } | { configured: false; error: string }
  devices: { id: string; name: string; addedAt: number; lastSeen?: number; push: boolean }[]
  /** The code this instance is showing, and the phone waiting for the user to allow it. */
  pairing?: { qr: string; expires: number; request?: { device: string; name: string } }
}

/** No arguments → the connection, the paired phones and the pairing in progress. */
export const StatusAction = actionRef<null, PhoneStatus>('phone', 'status')
/** No arguments → a pairing code (`ultimate-pair:…`, valid until `expires`, ms epoch); replaces an earlier one. */
export const PairStartAction = actionRef<null, { qr: string; expires: number }>(
  'phone',
  'pairStart',
)
/** No arguments → the status after withdrawing the code; a waiting phone is declined. */
export const PairCancelAction = actionRef<null, PhoneStatus>('phone', 'pairCancel')
/** `{ device }` → the status once the waiting phone is added and has its token. */
export const PairAllowAction = actionRef<{ device: string }, PhoneStatus>('phone', 'pairAllow')
/** `{ device }` → the status after the waiting phone was told "Pairing was declined". */
export const PairDenyAction = actionRef<{ device: string }, PhoneStatus>('phone', 'pairDeny')
/** `{ device }` → the status after removing a paired phone and closing its open connections. */
export const RevokeAction = actionRef<{ device: string }, PhoneStatus>('phone', 'revoke')
