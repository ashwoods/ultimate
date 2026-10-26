# Phone

Serves the Ultimate iPhone app. This instance opens one outbound WebSocket to your relay; a paired phone reaches it
through the relay over an end-to-end encrypted channel the relay cannot read. Ultimate still listens on loopback only.
The wire format, handshake and crypto are `docs/protocol.md` in the ultimate-ios repository, and `test/fixtures/phone-vectors.json`
is its reference output. Off by default and inert until configured.

## Setup

Turn it on with `extensions.enable: ["phone"]` and set, in **user** settings only (`~/.ultimate/settings.json`):

```json
{
  "phone": {
    "relay": "wss://relay.example.workers.dev",
    "elevenlabs": { "voice": "<voice id>", "model": "eleven_flash_v2_5" }
  }
}
```

Add `ULTIMATE_PHONE_RELAY_TOKEN` (the relay's deploy token) in the Secrets panel; `ELEVENLABS_API_KEY` too for speech.
`elevenlabs` is optional (default voice Sarah, model `eleven_flash_v2_5`). `ULTIMATE_PHONE_RELAY` overrides `phone.relay`
and `ULTIMATE_PHONE_STATE` the state file path. A preview instance (a home that is not the project's default) stays offline
unless `ULTIMATE_PHONE_RELAY` is set.

## State

`~/.ultimate/phone.json` (mode 0600, written atomically, re-read whenever it is used so every instance process shares it):
the machine id, `machineSecret`, the Mac's X25519 key pair, its name, and the paired devices with their token hash,
push token and Live Activity tokens. Nothing is created until the extension is configured.

## Actions

All are user-only (`userActions`).

- `status` → `{ state: 'off' | 'unconfigured' | 'connecting' | 'online' | 'error', error?, relay?, instance, devices, pairing? }`;
  `unconfigured` names the missing setting or secret in `error`.
- `pairStart` → `{ qr, expires }`: a code for 10 minutes, announced to the relay for this instance only. A phone that scans
  it calls `pair`, which waits until the user calls `pairAllow { device }` (mints the device token, stores the phone,
  sends `devices`) or `pairDeny { device }` ("Pairing was declined"). `pairCancel` withdraws the code.
- `revoke { device }` removes a phone, tells the relay and closes its open connections with 4401. Other instances notice
  at the phone's next call.

## UI

The status line's `phone` indicator opens a popover (`web.tsx`) with the `status` action, read on load, on open and
after a reinstall, and every second while the popover is open on a pairing. The dot is green while the relay connection
is up, grey while connecting, amber while unconfigured or failing, and brand while a pairing code is out; off (a preview)
it stays out of the line, and the palette's `Phone…` opens the popover in its place, saying why. Unconfigured, it shows
what `error` names, with **Add token** opening the Secrets panel at `ULTIMATE_PHONE_RELAY_TOKEN`. Connected, it lists
the paired phones with **Remove** (`revoke`, one click) and **Pair a phone**: a QR code with **Cancel**, **Copy code**
and the time left. A phone that scans it shows as a request naming the phone and this Mac, with **Deny** and **Allow**;
nothing is added without that click. After Allow the popover confirms the new phone until it closes.

## Files

`crypto.ts` (handshake, frames, ids), `state.ts`, `channel.ts` (one phone's handshake, counters and RPC dispatch),
`connector.ts` (the relay socket, reconnecting from 1 s to 30 s), `pairing.ts`, `runtime.ts` (configuration, status and
actions), `web.tsx` (the popover), `methods.ts` (the table of RPC methods a phone can call: `pair`, `ping`, `instances`, `push.register`,
`activity.register`, `tts.token`; add the rest there).
