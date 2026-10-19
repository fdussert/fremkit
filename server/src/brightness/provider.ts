import { z } from 'zod'
import type { CommandContext, Provider } from '../providers/types.js'
import { SCREEN_ID_RE, type Screen } from '../config/schema.js'
import { tr } from '../i18n.js'
import { BrightnessError, type BrightnessService } from './service.js'

/**
 * Every command names its screen, or none for the kiosk's. The host stamps `instanceId` onto a
 * widget's payloads too; zod's default `strip` drops it with anything else unexpected.
 */
const ScreenField = { screen: z.string().regex(SCREEN_ID_RE).optional() }
export const SetSchema = z.object({ ...ScreenField, value: z.number().finite() })
export const StepSchema = z.object({ ...ScreenField, delta: z.number().finite().min(-100).max(100) })
export const ResumeSchema = z.object({ ...ScreenField })

/** How often the schedule is re-read: a ramp moves one level every ten seconds or so. */
export const BRIGHTNESS_INTERVAL_MS = 5000

function parse<T>(schema: z.ZodType<T>, payload: unknown): T {
  const parsed = schema.safeParse(payload ?? {})
  if (!parsed.success) throw new Error(tr(undefined, 'provider.invalidPayload'))
  return parsed.data
}

/** The screen a paired device is bound to, or null for none (or an unknown device). */
export type DeviceScreenOf = (deviceId: string) => string | null

/**
 * Whether the client that sent a command may change this screen's brightness.
 *
 * - A socket on this Mac (`loopback`) may drive any screen.
 * - A paired device (`paired`) may drive only its own screen: the one `deviceScreenOf` says it
 *   is bound to *now*, and only while that screen is a `device` screen. `screen` is read from the
 *   live config at command time, so a screen deleted or turned into something else since the
 *   device paired is refused. A paired device never drives the Edge.
 * - Anything else — no context, a socket neither local nor paired — drives nothing.
 */
export function mayCommandBrightness(ctx: CommandContext | undefined, screen: Screen, deviceScreenOf: DeviceScreenOf = () => null): boolean {
  if (ctx?.loopback === true) return true
  if (ctx?.paired !== true || !ctx.deviceId) return false
  return screen.kind === 'device' && deviceScreenOf(ctx.deviceId) === screen.id
}

function run<T>(fn: () => T): T {
  try {
    return fn()
  } catch (err) {
    if (err instanceof BrightnessError) {
      throw new Error(tr(undefined, err.code === 'unknown-screen' ? 'brightness.unknownScreen' : 'brightness.unavailable'))
    }
    throw err
  }
}

/**
 * The `brightness` channel: every screen's level, target and mode (see `service.ts`).
 *
 * Polled every few seconds so the day/night ramp advances and an expired manual change gives way;
 * a command or a helper report asks for an immediate poll through `changed`, so a slider answers
 * at once. The registry only publishes when the snapshot actually changed.
 */
export function createBrightnessProvider(
  service: BrightnessService,
  changed: () => void = () => {},
  deviceScreenOf: DeviceScreenOf = () => null,
): Provider {
  const after = <T>(result: T): T => { changed(); return result }
  /** Fails closed: a caller with no context is treated as remote. */
  const guard = (screen: string | undefined, ctx: CommandContext | undefined): void => {
    run(() => {
      if (!mayCommandBrightness(ctx, service.screenOf(screen), deviceScreenOf)) throw new Error(tr(undefined, 'provider.localOnly'))
    })
  }
  return {
    channel: 'brightness',
    intervalMs: BRIGHTNESS_INTERVAL_MS,
    poll: async () => service.snapshot(),
    commands: {
      set: async (payload, ctx) => {
        const { screen, value } = parse(SetSchema, payload)
        guard(screen, ctx)
        return after(run(() => service.set(screen, value)))
      },
      step: async (payload, ctx) => {
        const { screen, delta } = parse(StepSchema, payload)
        guard(screen, ctx)
        return after(run(() => service.step(screen, delta)))
      },
      resume: async (payload, ctx) => {
        const { screen } = parse(ResumeSchema, payload)
        guard(screen, ctx)
        return after(run(() => service.resume(screen)))
      },
    },
  }
}
