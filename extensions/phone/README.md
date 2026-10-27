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
The environment variable `ULTIMATE_PHONE_RELAY_TOKEN` takes precedence over the secret, so a scratch server can point at a local relay.
`elevenlabs` is optional (default voice Sarah, model `eleven_flash_v2_5`). `ULTIMATE_PHONE_RELAY` overrides `phone.relay`
and `ULTIMATE_PHONE_STATE` the state file path. A preview instance (a home that is not the project's default) stays offline
unless `ULTIMATE_PHONE_RELAY` is set.

Phone needs `voice-live` (`need(VoiceLiveApi)`): without it the extension does not load.

### Push

Pushes are sent from this Mac over HTTP/2 (`apns.ts`), not through the relay. They are skipped until both are set; `status.push`
says which is missing.

```json
{
  "phone": {
    "apns": { "keyId": "ABC123DEFG", "teamId": "TEAM123456", "topic": "com.example.ultimate" }
  }
}
```

`topic` is the app's bundle id. Add `APNS_AUTH_KEY` (the contents of the `.p8` file) in the Secrets panel. Phones whose
`push.register` env is `sandbox` go to `api.sandbox.push.apple.com`, the others to `api.push.apple.com`.

- **Alert** when a job is answered or failed: the app's generic text plus `u.enc`, the summary sealed for that phone
  (`docs/protocol.md`, "Push"). An answer is announced when Voice's concluding line arrives (its `summary`, else the first
  sentence of Voice's speech), or 20 s after the answer without one (the first sentence of the answer, at most 140 characters).
  A failed job alerts at once with the notice text. Each phone gets one alert per job: the sent jobs are remembered in
  `phone.json` (`alerted`, the last 100 per phone), and jobs that concluded before this process started never alert.
- **Live Activity** for jobs whose activity token was registered: `update` with `{ state: "working", phase?, since }` when
  the phase changes (at most once per 10 s per job), `end` with `{ state, since, summary }` when the job concludes; the token
  is then forgotten. Activity pushes use the phone's push-registration environment (production when it has none).
- APNs answering 410 or `BadDeviceToken` drops that token from `phone.json`.

## The feed

`feed.ts` derives the phone's feed from Voice's transcript (`voice.heard`, `voice.line`, `voice.answer`), the live state of
@ultimate and the Messages log. `feed.subscribe { limit? }` (default 50, at most 200) answers the newest items and then
pushes `feed` events with the items that changed. A sealed message over the protocol's 1 MiB drops the oldest items until it fits.

- `heard`: a `voice.heard`. `said`: Voice's speech line without `re`. `job`: a forwarded line; `answered` once its
  `voice.answer` arrived (`detail` is the answer, cut at 16 KB), `failed` when Voice's notice for it arrived (`summary` is the notice, no
  `detail`). `speech` and `summary` come from Voice's concluding line (the one with that `re`).
- `at`: the entry's message time, else the message before it (Voice's lines carry none), except a job's own start time.
- `phase` on working jobs (all of them): `Thinking`, or a running tool by name (bash "Running a command", read "Reading
  files", edit and write "Editing", codemode "Looking things up", branch "Starting a branch", subagent "Delegating", message
  "Writing", else the tool name). Phase-only changes go out at most once a second.
- `question`: @ultimate's newest open reply-expected message to the user, on the newest job that started before it.

`say { id, text, via }` opens one Voice phone session per channel (`<device>:<random>`) and passes the line to
`VoiceLiveApi.heard(text, id, via)`, which admits an `id` once; `via` says whether the line was spoken or typed.
Replies are sent as written when they are an `RpcError`'s; any other failure reaches the phone as "Something went wrong on the Mac"
and is logged on the Mac.

## State

`~/.ultimate/phone.json` (mode 0600, written atomically, re-read whenever it is used so every instance process shares it):
the machine id, `machineSecret`, the Mac's X25519 key pair, its name, and the paired devices with their token hash,
push token and Live Activity tokens (keyed `<instance>:<job>`, since job ids repeat across projects). Changes go through a
lock file beside it (`phone.json.lock`, broken after 10 s), so processes do not overwrite each other. Nothing is created
until the extension is configured.

## Actions

All are user-only (`userActions`).

- `status` → `{ state: 'off' | 'unconfigured' | 'connecting' | 'online' | 'error', error?, relay?, name?, missing?, instance, devices, push?, pairing? }`;
  `unconfigured` names the missing setting or secret in `error` and says which in `missing` (`'relay'` or `'token'`). `name` is
  the Mac's name from the state file. `push` is `{ configured: true }` or `{ configured: false, error }`. A device's `lastSeen`
  moves when it handshakes or calls a method, at most once a minute.
- `pairStart` → `{ expires }`: a code for 10 minutes, announced to the relay for this instance only. The code itself is in
  `status.pairing` (`{ v, relay, machine, instance, key, token, name, expires, request? }`; `pairingQr` in `refs.ts` makes the
  `ultimate-pair:` text), so the call trace, which blanks values under `token`, never stores it. A phone that scans
  it calls `pair`, which waits until the user calls `pairAllow { device }` (mints the device token, stores the phone,
  sends `devices`) or `pairDeny { device }` ("Pairing was declined"). `pairCancel` withdraws the code.
  Denying or cancelling answers a waiting phone "Pairing was declined" before the relay is told to withdraw the code.
- `revoke { device }` removes a phone, tells the relay and closes its open connections with 4401. Other instances notice
  at the phone's next call or the next event they would send it, and close it then.

Changing the relay or its token in the settings reconnects; other settings are read when used and keep the socket and an
open pairing. When another process of the same project takes the relay socket (4409) this one stays offline
(`status.replaced`) until it is restarted.

## UI

The status line's `phone` indicator opens a popover (`web.tsx`) with the `status` action, read on load, on open and
after a reinstall, and every second while the popover is open on a pairing. The dot is green while the relay connection
is up, grey while connecting, amber while unconfigured or failing, and brand while a pairing code is out; off (a preview)
it stays out of the line, and the palette's `Phone…` opens the popover in its place, saying why. Unconfigured, it shows
what `error` names, with **Add token** opening the Secrets panel at `ULTIMATE_PHONE_RELAY_TOKEN`. Connected, it lists
the paired phones with **Remove** (`revoke`, one click) and **Pair a phone**: a QR code with **Cancel**, **Copy code**
and the time left. A phone that scans it shows as a request naming the phone and this Mac with a short code (`ABC·DEF`, the start of the phone's
id) that the phone shows too, and **Deny** and **Allow**;
nothing is added without that click. After Allow the popover confirms the new phone until it closes.

## Files

`crypto.ts` (handshake, frames, ids), `state.ts`, `channel.ts` (one phone's handshake, counters and RPC dispatch),
`connector.ts` (the relay socket, reconnecting from 1 s to 30 s), `pairing.ts`, `runtime.ts` (configuration, status and
actions), `web.tsx` (the popover), `methods.ts` (the table of RPC methods a phone can call: `pair`, `ping`, `instances`, `say`, `feed.subscribe`,
`push.register`, `activity.register`, `tts.token`), `feed.ts` (feed items and their sources), `push.ts` (alerts and Live
Activities), `apns.ts` (the HTTP/2 client and provider token).
