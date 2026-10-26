/**
 * Voice live: the standing Voice agent can be driven by a phone instead of GPT-Live. Another extension opens a phone
 * session and feeds it heard lines; no OpenAI key is involved.
 */
import { defineApi } from '../../shared/extension-api.ts'

/** What the `voice-live` service gives other extensions. */
export interface VoiceLiveService {
  /**
   * Start phone session `session`: ensure the Voice conversation, mark the session started and place the context brief.
   * Repeating a session id writes nothing twice. Returns the Voice conversation id.
   */
  open(session: string): Promise<number>
  /** A finished transcript from the phone. A repeated `id` is admitted once. */
  heard(text: string, id: string): Promise<void>
  /** The Voice conversation id, once it exists. */
  conversation(): Promise<number | undefined>
}
/** Phone sessions for Voice; `want` it, since voice-live is optional. */
export const VoiceLiveApi = defineApi<VoiceLiveService>()('voice-live')
