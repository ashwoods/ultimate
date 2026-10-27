import {
  CheckIcon,
  CircleCheckIcon,
  CopyIcon,
  KeyRoundIcon,
  LoaderCircleIcon,
  LockIcon,
  RefreshCwIcon,
  SmartphoneIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  api,
  cn,
  defineWebExtension,
  errorMessage,
  events,
  formatAgo,
  useCopy,
  useEvent,
  useNow,
  useSystem,
} from '@/sdk'
import { encode } from 'uqr'
import {
  PairAllowAction,
  PairCancelAction,
  PairDenyAction,
  PairStartAction,
  RevokeAction,
  StatusAction,
} from './refs.ts'
import type { PhoneStatus } from './refs.ts'

type Device = PhoneStatus['devices'][number]
/** What happened last in this popover, shown until it closes. */
type Outcome =
  | { kind: 'paired'; name: string }
  | { kind: 'declined'; name: string }
  | { kind: 'expired' }

/**
 * The status, read on mount, on open and after a reinstall (a settings change), then every second while the popover
 * is open on a pairing. An action's result replaces it; a poll that started before the action is dropped, so an
 * allowed phone never flashes back as waiting.
 */
function usePhone(open: boolean) {
  const system = useSystem()
  const loadedAt = system?.extensions.find((extension) => extension.name === 'phone')?.server
    ?.loadedAt
  const [status, setStatus] = useState<PhoneStatus>()
  const [error, setError] = useState<string>()
  const latest = useRef(0)
  const apply = useCallback(async (call: Promise<PhoneStatus>) => {
    const turn = ++latest.current
    try {
      const next = await call
      if (turn === latest.current) {
        setStatus(next)
        setError(undefined)
      }
      return next
    } catch (failure) {
      if (turn === latest.current) setError(errorMessage(failure))
      throw failure
    }
  }, [])
  const read = useCallback(
    () =>
      apply(api.action(StatusAction)).catch(() => {
        // Shown as `error` in the popover; the status line has nowhere else to report it.
      }),
    [apply],
  )
  useEffect(() => {
    // oxlint-disable-next-line typescript/no-floating-promises -- read catches: a failure lands in `error`.
    void read()
  }, [read, open, loadedAt])
  const pairing = !!status?.pairing
  useEffect(() => {
    if (!open || !pairing) return undefined
    const timer = setInterval(() => void read(), 1000)
    return () => clearInterval(timer)
  }, [open, pairing, read])
  return { status, error, read, apply }
}
type Phone = ReturnType<typeof usePhone>

const dot = (tone: string) => <span className={cn('size-1.5 shrink-0 rounded-full', tone)} />

function Heading({ children, meta }: { children: ReactNode; meta?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 font-mono text-[10.5px] tracking-wider text-muted-foreground uppercase">
      {children}
      {meta !== undefined && (
        <span className="ml-auto flex items-center gap-1.5 tracking-normal normal-case">
          {meta}
        </span>
      )}
    </div>
  )
}

const small = 'h-7 gap-1.5 px-2 font-mono text-[11.5px]'

/** A button that runs `run`, spins while it does, and shows its failure under it. */
function useRun() {
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const run = async (id: string, work: () => Promise<unknown>) => {
    setBusy(id)
    setError(undefined)
    try {
      await work()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(undefined)
    }
  }
  return { busy, error, run }
}

const Failure = ({ error }: { error?: string }) =>
  error ? <p className="mt-2 font-mono text-[11px] leading-snug text-error">{error}</p> : null

function Problem({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <>
      <p className="mt-2.5 flex items-center gap-1.5 text-[13px] text-foreground">
        <TriangleAlertIcon className="size-3.5 shrink-0 text-warning" />
        {title}
      </p>
      {children}
    </>
  )
}

function CheckAgain({ phone }: { phone: Phone }) {
  const { busy, run } = useRun()
  return (
    <Button
      className={cn(small, 'mt-3')}
      disabled={!!busy}
      onClick={() => void run('check', phone.read)}
      size="sm"
      variant="outline"
    >
      {busy ? (
        <LoaderCircleIcon className="size-3.5 animate-spin" />
      ) : (
        <RefreshCwIcon className="size-3.5" />
      )}
      Check again
    </Button>
  )
}

/** What the server says is missing, with the way to add it: the Secrets panel for the token. */
function Unconfigured({
  error,
  missing,
  phone,
}: {
  error?: string
  missing?: PhoneStatus['missing']
  phone: Phone
}) {
  const secret = missing === 'token' ? 'ULTIMATE_PHONE_RELAY_TOKEN' : undefined
  return (
    <Problem title="Finish setting up the relay">
      {error && (
        <p className="mt-1 text-[12px] leading-snug break-words text-muted-foreground">{error}</p>
      )}
      <div className="flex gap-1.5">
        {secret && (
          <Button
            className={cn(small, 'mt-3')}
            onClick={() => events.emit('secrets:open', { name: secret })}
            size="sm"
          >
            <KeyRoundIcon className="size-3.5" />
            Add token
          </Button>
        )}
        <CheckAgain phone={phone} />
      </div>
    </Problem>
  )
}

/** One paired phone; Remove cuts it off at once: the relay forgets its token and its open connections close. */
function DeviceRow({ device, phone, fresh }: { device: Device; phone: Phone; fresh: boolean }) {
  const { busy, error, run } = useRun()
  const now = useNow(60_000)
  const seen = device.lastSeen
    ? `seen ${formatAgo(device.lastSeen, now, { ago: true })}`
    : 'not seen yet'
  return (
    <li className="py-1.5">
      <div className="flex items-center gap-2.5">
        <SmartphoneIcon
          className={cn('size-4 shrink-0', fresh ? 'text-success' : 'text-muted-foreground')}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] text-foreground" title={device.name}>
            {device.name}
          </p>
          <p className="font-mono text-[10.5px] text-muted-foreground">
            added {formatAgo(device.addedAt, now, { ago: true })} · {seen}
          </p>
        </div>
        <Button
          aria-label={`Remove ${device.name}`}
          className="-mr-2 h-6 px-2 font-mono text-[11px] text-muted-foreground hover:bg-error/10 hover:text-error"
          disabled={!!busy}
          onClick={() =>
            void run('remove', () => phone.apply(api.action(RevokeAction, { device: device.id })))
          }
          size="xs"
          title="Remove: it can no longer reach this Mac"
          variant="ghost"
        >
          {busy ? <LoaderCircleIcon className="size-3 animate-spin" /> : 'Remove'}
        </Button>
      </div>
      <Failure error={error} />
    </li>
  )
}

/** The paired phones and the way to add one; pairing needs the relay connection. */
function Phones({
  status,
  phone,
  outcome,
  onPair,
}: {
  status: PhoneStatus
  phone: Phone
  outcome?: Outcome
  onPair: () => Promise<unknown>
}) {
  const { busy, error, run } = useRun()
  const online = status.state === 'online'
  const { devices } = status
  const newest =
    outcome?.kind === 'paired' ? devices.findLast((d) => d.name === outcome.name) : undefined
  return (
    <>
      {outcome?.kind === 'paired' && (
        <div className="mt-3 rounded-md border border-success/30 bg-success/5 px-2.5 py-2">
          <p className="flex items-center gap-1.5 text-[13px] text-foreground">
            <CircleCheckIcon className="size-3.5 shrink-0 text-success" />
            <span className="min-w-0 truncate">{outcome.name} is paired</span>
          </p>
          <p className="mt-0.5 pl-5 text-[12px] leading-snug text-muted-foreground">
            It can reach this Mac now. Remove it here to cut it off.
          </p>
        </div>
      )}
      {outcome?.kind === 'declined' && (
        <p className="mt-3 text-[12px] text-muted-foreground">
          Declined <span className="text-foreground/90">{outcome.name}</span>; it was not added.
        </p>
      )}
      {outcome?.kind === 'expired' && (
        <p className="mt-3 text-[12px] text-muted-foreground">
          The code expired before a phone paired.
        </p>
      )}
      {devices.length > 0 ? (
        <ul className="mt-2 -mb-1 divide-y divide-border/60">
          {devices.map((device) => (
            <DeviceRow device={device} fresh={device === newest} key={device.id} phone={phone} />
          ))}
        </ul>
      ) : (
        <p className="mt-2.5 text-[12px] leading-snug text-muted-foreground">
          No phone is paired. Pair the Ultimate app on your iPhone to reach this Mac's projects from
          anywhere.
        </p>
      )}
      <Button
        className={cn(small, 'mt-3')}
        disabled={!online || !!busy}
        onClick={() => void run('pair', onPair)}
        size="sm"
        title={online ? undefined : 'Pairing needs the relay connection'}
        variant={devices.length ? 'outline' : 'default'}
      >
        {busy ? (
          <LoaderCircleIcon className="size-3.5 animate-spin" />
        ) : (
          <SmartphoneIcon className="size-3.5" />
        )}
        {devices.length ? 'Pair another phone' : 'Pair a phone'}
      </Button>
      <Failure error={error} />
    </>
  )
}

const countdown = (ms: number) => {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** The code to scan while it is valid, with its remaining time. */
function Code({ pairing, phone }: { pairing: NonNullable<PhoneStatus['pairing']>; phone: Phone }) {
  const now = useNow(1000)
  const { busy, error, run } = useRun()
  const { copied, copy } = useCopy()
  const left = pairing.expires - now
  return (
    <>
      <div className="mt-3">
        <QrCode text={pairing.qr} />
      </div>
      <p className="mt-3 text-[12.5px] leading-snug text-foreground">
        Scan this with the Ultimate app on your iPhone.
      </p>
      <p className="mt-1 text-[12px] leading-snug text-muted-foreground">
        Nothing is added until you allow the phone here.
      </p>
      <div className="mt-3 flex items-center gap-1.5">
        <Button
          className={small}
          disabled={!!busy}
          onClick={() => void run('cancel', () => phone.apply(api.action(PairCancelAction)))}
          size="sm"
          variant="outline"
        >
          {busy && <LoaderCircleIcon className="size-3.5 animate-spin" />}
          Cancel
        </Button>
        <Button
          className={cn(small, 'text-muted-foreground')}
          onClick={() => copy(pairing.qr)}
          size="sm"
          title="Copy the code as text, for a phone without a camera"
          variant="ghost"
        >
          {copied ? (
            <CheckIcon className="size-3.5 text-success" />
          ) : (
            <CopyIcon className="size-3.5" />
          )}
          {copied ? 'Copied' : 'Copy code'}
        </Button>
        <span
          className={cn(
            'ml-auto font-mono text-[11px] tabular-nums',
            left < 60_000 ? 'text-warning' : 'text-muted-foreground',
          )}
          title="The code stops working then"
        >
          expires in {countdown(left)}
        </span>
      </div>
      <Failure error={error} />
    </>
  )
}

/**
 * The phone that scanned the code, waiting on the user's answer: its name, this Mac, and what allowing grants. Only
 * their click on Allow adds it.
 */
function Request({
  request,
  phone,
  onAllowed,
  onDenied,
}: {
  request: NonNullable<NonNullable<PhoneStatus['pairing']>['request']>
  phone: Phone
  onAllowed: () => void
  onDenied: () => void
}) {
  const system = useSystem()
  const mac = phone.status?.name ?? system?.machine.hostname ?? 'this Mac'
  const { busy, error, run } = useRun()
  return (
    <div className="mt-3 rounded-md border border-brand/50 bg-brand/5 p-3" role="alertdialog">
      <div className="flex items-start gap-2.5">
        <SmartphoneIcon className="mt-0.5 size-5 shrink-0 text-brand" />
        <div className="min-w-0">
          <p className="text-[14px] leading-snug font-medium break-words text-foreground">
            {request.name}
          </p>
          <p className="text-[12.5px] leading-snug text-muted-foreground">
            wants to pair with <span className="text-foreground/90">{mac}</span>
          </p>
        </div>
      </div>
      <p className="mt-2.5 text-[12px] leading-snug text-foreground/90">
        Allowing it lets this phone talk to every project running in Ultimate on this Mac, from
        anywhere, until you remove it.
      </p>
      <p className="mt-1 text-[12px] leading-snug text-muted-foreground">
        Only allow it if it is the phone in your hand.
      </p>
      <div className="mt-3 grid grid-cols-2 gap-1.5">
        <Button
          className={small}
          disabled={!!busy}
          onClick={() =>
            void run('deny', async () => {
              await phone.apply(api.action(PairDenyAction, { device: request.device }))
              onDenied()
            })
          }
          size="sm"
          variant="outline"
        >
          {busy === 'deny' && <LoaderCircleIcon className="size-3.5 animate-spin" />}
          Deny
        </Button>
        <Button
          className={small}
          disabled={!!busy}
          onClick={() =>
            void run('allow', async () => {
              await phone.apply(api.action(PairAllowAction, { device: request.device }))
              onAllowed()
            })
          }
          size="sm"
        >
          {busy === 'allow' ? (
            <LoaderCircleIcon className="size-3.5 animate-spin" />
          ) : (
            <CheckIcon className="size-3.5" />
          )}
          Allow
        </Button>
      </div>
      <Failure error={error} />
    </div>
  )
}

/** Where the relay is, in the footer of a connected popover. */
const relayHost = (relay: string) => {
  try {
    return new URL(relay).host
  } catch {
    // Not a URL the browser parses: show it as the server has it.
    return relay
  }
}

/** Everything about the phone link in one place: whether it works, what to fix, pairing and the paired phones. */
function Details({ phone }: { phone: Phone }) {
  const { status, error } = phone
  const [outcome, setOutcome] = useState<Outcome>()
  const shown = useRef<PhoneStatus['pairing']>(undefined)
  // A code that disappears on its own expired (or was withdrawn elsewhere, which needs no note).
  useEffect(() => {
    const before = shown.current
    shown.current = status?.pairing
    if (before && !status?.pairing && before.expires <= Date.now() + 1000)
      setOutcome((current) => current ?? { kind: 'expired' })
  }, [status?.pairing])
  const state = status?.state
  const pairing = status?.pairing
  const meta =
    state === 'online' ? (
      <span className="flex items-center gap-1.5 text-success">
        {dot('bg-success')}
        connected
      </span>
    ) : state === 'off' ? (
      <span className="text-muted-foreground/70">off</span>
    ) : state === 'connecting' || (!status && !error) ? (
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <LoaderCircleIcon className="size-3 animate-spin" />
        connecting…
      </span>
    ) : state ? (
      <span className="flex items-center gap-1.5 text-warning">
        {dot('bg-warning')}
        needs a fix
      </span>
    ) : undefined
  const linked = state === 'online' || state === 'connecting' || state === 'error'
  return (
    <section className="px-3 pt-3 pb-3.5 font-sans">
      <Heading meta={meta}>
        {pairing ? (pairing.request ? 'Pair request' : 'Pair a phone') : 'Phone'}
      </Heading>
      {error && !status && (
        <p className="mt-2.5 font-mono text-[11px] leading-snug text-error">{error}</p>
      )}
      {state === 'off' && (
        <>
          <p className="mt-2.5 text-[13px] text-foreground">Off in this preview</p>
          <p className="mt-1 text-[12px] leading-snug text-muted-foreground">
            Only the project's own Ultimate connects to your phone; previews and scratch servers
            stay offline. Pair from the main Ultimate window.
          </p>
        </>
      )}
      {state === 'unconfigured' && (
        <Unconfigured error={status?.error} missing={status?.missing} phone={phone} />
      )}
      {state === 'error' && (
        <Problem title="Phones can't reach this Mac">
          {status?.error && (
            <p
              className="mt-1 line-clamp-4 font-mono text-[11px] leading-snug break-words text-error/85"
              title={status.error}
            >
              {status.error}
            </p>
          )}
          <p className="mt-1.5 text-[12px] leading-snug text-muted-foreground">
            Ultimate keeps retrying the relay
            {status?.relay && <span className="font-mono"> {relayHost(status.relay)}</span>}.
          </p>
          <CheckAgain phone={phone} />
        </Problem>
      )}
      {status && linked && pairing?.request && (
        <Request
          onAllowed={() => setOutcome({ kind: 'paired', name: pairing.request!.name })}
          onDenied={() => setOutcome({ kind: 'declined', name: pairing.request!.name })}
          phone={phone}
          request={pairing.request}
        />
      )}
      {status && linked && pairing && !pairing.request && <Code pairing={pairing} phone={phone} />}
      {status && linked && !pairing && (
        <Phones
          onPair={async () => {
            setOutcome(undefined)
            await api.action(PairStartAction)
            await phone.read()
          }}
          outcome={outcome}
          phone={phone}
          status={status}
        />
      )}
      {status?.relay && state === 'online' && !pairing && (
        <p className="mt-3 flex items-center gap-1.5 border-t border-border/60 pt-2.5 text-[11.5px] leading-snug text-muted-foreground">
          <LockIcon className="size-3 shrink-0" />
          <span className="min-w-0 truncate">
            End-to-end encrypted through{' '}
            <span className="font-mono">{relayHost(status.relay)}</span>
          </span>
        </p>
      )}
    </section>
  )
}

/**
 * `text` as a QR code to scan with a phone: one SVG path with a rectangle per run of dark modules in a row, black on
 * white in either theme so every camera reads it. As in the tailscale extension.
 */
function QrCode({ text }: { text: string }) {
  const { size, path } = useMemo(() => {
    const qr = encode(text, { border: 2 })
    let d = ''
    qr.data.forEach((row, y) => {
      for (let x = 0; x < qr.size; x++) {
        if (!row[x]) continue
        const start = x
        while (row[x + 1]) x++
        d += `M${start} ${y}h${x - start + 1}v1h${start - x - 1}z`
      }
    })
    return { size: qr.size, path: d }
  }, [text])
  return (
    <svg
      aria-label="Pairing code to scan with the Ultimate app"
      className="mx-auto block size-44 rounded-sm bg-white"
      role="img"
      shapeRendering="crispEdges"
      viewBox={`0 0 ${size} ${size}`}
    >
      <path d={path} fill="black" />
    </svg>
  )
}

/**
 * "phone" in the status line: green while the relay connection is up, amber while it needs a fix, brand while a
 * pairing code is out. A click opens the details above it. Off, it stays out of the line; `Phone…` in the palette
 * opens the details anchored where it would be.
 */
function Indicator() {
  const [open, setOpen] = useState(false)
  const phone = usePhone(open)
  useEvent('phone:open', () => setOpen(true))
  const state = phone.status?.state
  const shown = state !== undefined && state !== 'off'
  if (!shown && !open) return null
  const trouble = state === 'unconfigured' || state === 'error'
  const pairing = !!phone.status?.pairing
  const tone = trouble
    ? 'bg-warning'
    : pairing
      ? 'bg-brand animate-pulse'
      : state === 'online'
        ? 'bg-success'
        : 'bg-muted-foreground/60 animate-pulse'
  const title = trouble
    ? 'Phone link needs a fix'
    : pairing
      ? 'A pairing code is showing'
      : state === 'online'
        ? 'Your phones can reach this Mac'
        : 'Connecting to the phone relay…'
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        {shown ? (
          <button
            className={cn(
              '-mx-1 flex items-center gap-1.5 rounded-sm px-1 transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground',
              trouble && 'text-warning',
            )}
            data-phone={state}
            title={title}
            type="button"
          >
            {dot(tone)}
            phone
          </button>
        ) : (
          // Off there is nothing to show in the bar; the palette's details hang from here.
          <span aria-hidden className="h-4 w-0" />
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 max-w-[calc(100vw-1rem)] p-0" side="top">
        <Details phone={phone} />
      </PopoverContent>
    </Popover>
  )
}

export default defineWebExtension({
  slots: { 'statusline.right': [Indicator] },
  commands: [
    { id: 'phone.panel', title: 'Phone…', run: () => events.emit('phone:open', undefined) },
  ],
})
