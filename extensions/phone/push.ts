/**
 * Pushes from the Mac: one alert per answered or failed job (its text sealed for the phone), and Live Activity updates
 * while @ultimate works. It follows the feed's job items; sending goes through `apns.ts`.
 */
import { sealPush, pushKey } from './crypto.ts'
import type { ApnsEnv, ApnsRequest, ApnsResult } from './apns.ts'
import type { FeedItem, JobItem } from './feed.ts'
import { macKeys } from './state.ts'
import type { PhoneDevice, PhoneState } from './state.ts'

/** How long an answer waits for Voice's concluding speech before it is announced with its own first sentence. */
export const ANSWER_WAIT = 20000
/** Between Live Activity updates of one job; a change of state is not held. */
export const ACTIVITY_EVERY = 10000
const SUMMARY_MAX = 140
const ALERTED_MAX = 100
const DONE_MAX = 500

/** The first sentence of `text`, clipped to a lock-screen line. */
export function summaryOf(text: string | undefined) {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim()
  const sentence = flat.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? flat
  return sentence.length > SUMMARY_MAX
    ? `${sentence.slice(0, SUMMARY_MAX - 1).trimEnd()}…`
    : sentence
}

export type PushDeps = {
  instance(): string
  now(): number
  /** Where to send, or undefined while push is not configured. */
  apns(): Promise<{ send(request: ApnsRequest): Promise<ApnsResult>; topic: string } | undefined>
  state: {
    read(): Promise<PhoneState>
    update(modify: (state: PhoneState) => void): Promise<void>
  }
  /** Ask to be called again at `at` (ms epoch). */
  schedule(at: number): void
  notice(message: string): void
}

/** Send one request; when APNs says the token is dead, `drop` removes it from the device it belonged to. */
type Send = (
  request: ApnsRequest,
  drop: (device: PhoneDevice) => void,
  device: string,
) => Promise<void>
type Sent = { state: string; phase?: string; at: number }
/** APNs says this token will never work again. */
const dead = (result: ApnsResult) => result.status === 410 || result.reason === 'BadDeviceToken'

export class Pusher {
  #deps: PushDeps
  #queue: Promise<void> = Promise.resolve()
  #started = false
  /** Jobs whose alert and Live Activity end are handled, or were skipped. */
  #done = new Set<number>()
  /** When an answered job without Voice's speech was first seen. */
  #waiting = new Map<number, number>()
  /** The last Live Activity update by `<device>:<job>`. */
  #sent = new Map<string, Sent>()

  constructor(deps: PushDeps) {
    this.#deps = deps
  }

  /** The feed's items after a refresh. Handled one after the other. */
  observe(items: readonly FeedItem[]) {
    this.#queue = this.#queue
      .then(() => this.#run(items))
      .catch((error: unknown) => {
        this.#deps.notice(`Phone push: ${error instanceof Error ? error.message : String(error)}`)
      })
    return this.#queue
  }

  async #run(items: readonly FeedItem[]) {
    const jobs = items.filter((item): item is JobItem => item.kind === 'job')
    // Whatever concluded before the first look happened before this process started: no alert for it.
    if (!this.#started) {
      this.#started = true
      for (const job of jobs) if (job.state !== 'working') this.#done.add(job.id)
    }
    const working: JobItem[] = []
    const concluded: JobItem[] = []
    for (const job of jobs) {
      if (this.#done.has(job.id)) continue
      if (job.state === 'working') working.push(job)
      else if (job.state === 'failed' || job.speech !== undefined) concluded.push(job)
      else {
        const since = this.#waiting.get(job.id) ?? this.#deps.now()
        this.#waiting.set(job.id, since)
        if (this.#deps.now() - since >= ANSWER_WAIT) concluded.push(job)
        else this.#deps.schedule(since + ANSWER_WAIT)
      }
    }
    for (const job of concluded) {
      this.#done.add(job.id)
      this.#waiting.delete(job.id)
    }
    for (const old of [...this.#done].slice(0, -DONE_MAX)) this.#done.delete(old)
    if (!working.length && !concluded.length) return
    const apns = await this.#deps.apns()
    if (!apns) return
    const dropped: ((state: PhoneState) => void)[] = []
    const send: Send = async (request, drop, device) => {
      try {
        const result = await apns.send(request)
        if (dead(result))
          dropped.push((state) => {
            const known = state.devices.find((entry) => entry.id === device)
            if (known) drop(known)
          })
        else if (result.status !== 200)
          this.#deps.notice(
            `Phone push: APNs answered ${result.status} ${result.reason ?? ''}`.trim(),
          )
      } catch (error) {
        this.#deps.notice(`Phone push: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const devices = (await this.#deps.state.read()).devices
    const sends: Promise<void>[] = []
    for (const job of working) sends.push(...this.#update(apns.topic, devices, job, send))
    for (const job of concluded) {
      sends.push(...(await this.#alert(apns.topic, job, send)))
      sends.push(...this.#end(apns.topic, devices, job, send))
    }
    await Promise.all(sends)
    if (dropped.length)
      await this.#deps.state.update((state) => {
        for (const apply of dropped) apply(state)
      })
  }

  #activityRequest(
    topic: string,
    device: PhoneDevice,
    token: string,
    event: 'update' | 'end',
    content: object,
    priority: 5 | 10,
    job: number,
  ): ApnsRequest {
    return {
      token,
      // The activity token does not say which Apple environment it belongs to; the phone's push token does.
      env: device.push?.env ?? 'production',
      type: 'liveactivity',
      topic: `${topic}.push-type.liveactivity`,
      priority,
      collapseId: `la-${this.#deps.instance()}-${job}`,
      payload: {
        aps: {
          timestamp: Math.floor(this.#deps.now() / 1000),
          event,
          'content-state': content,
        },
      },
    }
  }

  /** Live Activity updates for a working job: when its phase changed, at most every `ACTIVITY_EVERY`. */
  #update(topic: string, devices: readonly PhoneDevice[], job: JobItem, send: Send) {
    const now = this.#deps.now()
    const sends: Promise<void>[] = []
    for (const device of devices) {
      const token = device.activities?.[job.id]
      if (!token) continue
      const key = `${device.id}:${job.id}`
      const last = this.#sent.get(key)
      if (last && last.phase === job.phase) continue
      if (last && now - last.at < ACTIVITY_EVERY) {
        this.#deps.schedule(last.at + ACTIVITY_EVERY)
        continue
      }
      this.#sent.set(key, { state: job.state, ...(job.phase && { phase: job.phase }), at: now })
      const content = { state: 'working', ...(job.phase && { phase: job.phase }), since: job.at }
      sends.push(
        send(
          this.#activityRequest(topic, device, token, 'update', content, 5, job.id),
          (known) => {
            if (known.activities?.[job.id] === token) delete known.activities[job.id]
          },
          device.id,
        ),
      )
    }
    return sends
  }

  /** The job is over: end its Live Activities with the summary, and forget their tokens. */
  #end(topic: string, devices: readonly PhoneDevice[], job: JobItem, send: Send) {
    const sends: Promise<void>[] = []
    for (const device of devices) {
      const token = device.activities?.[job.id]
      if (!token) continue
      this.#sent.delete(`${device.id}:${job.id}`)
      const content = { state: job.state, since: job.at, summary: this.#summary(job) }
      sends.push(
        send(
          this.#activityRequest(topic, device, token, 'end', content, 10, job.id),
          (known) => {
            if (known.activities?.[job.id] === token) delete known.activities[job.id]
          },
          device.id,
        ),
      )
    }
    if (sends.length)
      sends.push(
        this.#deps.state.update((state) => {
          for (const known of state.devices) delete known.activities?.[job.id]
        }),
      )
    return sends
  }

  #summary(job: JobItem) {
    const text =
      job.state === 'failed'
        ? job.summary
        : job.summary || summaryOf(job.speech) || summaryOf(job.detail)
    return text || (job.state === 'failed' ? 'Failed' : 'Answered')
  }

  /** One alert per phone with a push token, claimed in the state file first so no other process sends it twice. */
  async #alert(topic: string, job: JobItem, send: Send) {
    const instance = this.#deps.instance()
    const tag = `${instance}:${job.id}`
    const body = this.#summary(job)
    const claimed: { id: string; key: Buffer; token: string; env: ApnsEnv }[] = []
    let keys: ReturnType<typeof macKeys> | undefined
    await this.#deps.state.update((state) => {
      keys = macKeys(state)
      for (const device of state.devices) {
        if (!device.push || device.alerted?.includes(tag)) continue
        const alerted = (device.alerted ??= [])
        alerted.push(tag)
        alerted.splice(0, alerted.length - ALERTED_MAX)
        claimed.push({
          id: device.id,
          key: Buffer.from(device.key, 'base64url'),
          token: device.push.token,
          env: device.push.env,
        })
      }
    })
    return claimed.map((phone) =>
      send(
        {
          token: phone.token,
          env: phone.env,
          type: 'alert',
          topic,
          priority: 10,
          collapseId: tag,
          payload: {
            aps: {
              alert: {
                title: 'Ultimate',
                body: job.state === 'failed' ? '@ultimate failed' : '@ultimate answered',
              },
              'mutable-content': 1,
              sound: 'default',
              'thread-id': instance,
              category: 'ANSWER',
            },
            u: {
              instance,
              job: job.id,
              enc: sealPush(
                pushKey(keys!, phone.key),
                Buffer.from(JSON.stringify({ title: 'Ultimate', body, job: job.id })),
              ),
            },
          },
        },
        (known) => {
          if (known.push?.token === phone.token) delete known.push
        },
        phone.id,
      ),
    )
  }
}
