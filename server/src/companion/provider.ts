/**
 * The `companion` channel: the browser extension's share as the dashboard sees it, the pairing
 * request waiting for an answer on the Edge, and which page to bring forward when a share starts.
 *
 * The state is pushed: the session and the pairing say when it changed, and `createCompanion`
 * asks the registry for a poll at once. The poll itself only reads.
 *
 * The commands are the fremplay widget's — watch, answer an offer, stop watching, steer the
 * player — and are this Mac's only: what is playing in a browser here is not a paired iPad's to
 * see or drive, in this first version.
 */

import { z } from 'zod'
import { INSTANCE_ID_MAX, type Config } from '../config/schema.js'
import { tr, type MessageKey } from '../i18n.js'
import type { CommandContext, Provider } from '../providers/types.js'
import type { CompanionPairing } from './pairing.js'
import { placeFremplay } from './placement.js'
import { ControlSchema, isLocalSdp, MAX_SDP } from './protocol.js'
import type { CompanionSession, CompanionState } from './session.js'

export const COMPANION_CHANNEL = 'companion'

/** A safety net only: every change is pushed through a refresh. */
export const COMPANION_INTERVAL_MS = 30_000

export type CompanionSnapshot = CompanionState & {
  /** The request waiting for the user's answer, for the Edge's approval overlay. Never the token. */
  pairing: { requestId: string; code: string; name: string; expiresAt: number; turnedAway: number } | null
  /**
   * The page to show when a share starts. `seq` goes up once per accepted share whose widget sits
   * on a page of the Edge's screen; the dashboard turns to it when `seq` differs from the last it
   * saw. Kept after the share ends, so a reload does not take it for a new one.
   */
  reveal: { seq: number; screenId: string; pageIndex: number } | null
}

export interface CompanionProvider extends Provider<CompanionSnapshot> {
  /**
   * The session changed: notices a share that has just been accepted. A share taken back through
   * `hello` after a server restart is noted but not revealed: it was on screen already, and the
   * page the user turned to since is theirs.
   */
  noteChange(): void
}

export interface CompanionProviderOptions {
  session: CompanionSession
  pairing: Pick<CompanionPairing, 'pending'>
  config: () => Config
}

// The host stamps `instanceId` on every widget command; here it is required, and nothing else is
// let through.
const InstanceId = z.string().min(1).max(INSTANCE_ID_MAX)
const ReceiverId = z.uuid()
const ViewSchema = z.strictObject({ receiverId: ReceiverId, instanceId: InstanceId })
const AnswerSchema = z.strictObject({
  receiverId: ReceiverId,
  instanceId: InstanceId,
  sdp: z.string().max(MAX_SDP).refine((sdp) => isLocalSdp(sdp), 'not a local answer'),
})
const LeaveSchema = ViewSchema
const ControlCommandSchema = z.looseObject({ instanceId: InstanceId })

type Result = { ok: true } | { ok: false; error: string }

export function createCompanionProvider(opts: CompanionProviderOptions): CompanionProvider {
  const { session, pairing } = opts
  const locale = () => opts.config().locale
  let reveal: CompanionSnapshot['reveal'] = null
  /** The share last seen, so one share is revealed once however often it changes. */
  let lastSessionId: string | null = null

  function parse<T>(schema: z.ZodType<T>, payload: unknown): T {
    const parsed = schema.safeParse(payload)
    if (!parsed.success) throw new Error(tr(locale(), 'provider.invalidPayload'))
    return parsed.data
  }

  /** Fails closed: no context, or a paired device, is not this Mac. */
  function guard(ctx: CommandContext | undefined): void {
    if (ctx?.loopback !== true) throw new Error(tr(locale(), 'provider.localOnly'))
  }

  const result = (ok: boolean, key: MessageKey): Result => (ok ? { ok: true } : { ok: false, error: tr(locale(), key) })

  return {
    channel: COMPANION_CHANNEL,
    intervalMs: COMPANION_INTERVAL_MS,

    async poll() {
      return { ...session.snapshot(), pairing: pairing.pending(), reveal }
    },

    noteChange() {
      const sessionId = session.snapshot().tab.sessionId
      if (sessionId === lastSessionId) return
      lastSessionId = sessionId
      if (sessionId === null || session.shareResumed()) return
      // Read when the share starts: the widget may have moved since the last one.
      const place = placeFremplay(opts.config())
      if (place?.pageIndex == null) return
      reveal = { seq: (reveal?.seq ?? 0) + 1, screenId: place.screenId, pageIndex: place.pageIndex }
    },

    commands: {
      view: async (payload, ctx) => {
        guard(ctx)
        const { receiverId, instanceId } = parse(ViewSchema, payload)
        return result(session.view(receiverId, instanceId), 'companion.viewRefused')
      },
      answer: async (payload, ctx) => {
        guard(ctx)
        const { receiverId, instanceId, sdp } = parse(AnswerSchema, payload)
        return result(session.answer(receiverId, instanceId, sdp), 'companion.answerRefused')
      },
      leave: async (payload, ctx) => {
        guard(ctx)
        const { receiverId, instanceId } = parse(LeaveSchema, payload)
        session.leave(receiverId, instanceId)
        return { ok: true }
      },
      control: async (payload, ctx) => {
        guard(ctx)
        // `ControlSchema` is refined, so it cannot be extended: the instance id is taken off and
        // the rest must be exactly a control.
        const { instanceId: _instanceId, ...control } = parse(ControlCommandSchema, payload)
        return result(session.control(parse(ControlSchema, control)), 'companion.noShare')
      },
    },
  }
}
