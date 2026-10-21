import { describe, expect, it } from 'vitest'
import type { InstanceLookup } from '../src/config/instances.js'
import type { CommandContext } from '../src/providers/types.js'
import { tr } from '../src/i18n.js'
import { createPastePadProvider } from '../src/providers/paste-pad.js'

const instance = (buttons: unknown) => ({
  widgetId: 'paste-pad',
  settings: { buttons },
})

/** An instances lookup that only answers when the caller's context is threaded through — like the
 * production one in app.ts, which scopes by CommandContext and fails closed without it. */
const scopedLookup = (view: ReturnType<typeof instance> | null) => {
  const box: { sawCtx: CommandContext | undefined } = { sawCtx: undefined }
  const lookup: InstanceLookup = (_id, ctx) => { box.sawCtx = ctx; return ctx?.loopback ? view : null }
  return { lookup, box }
}

describe('paste-pad provider', () => {
  it('pastes the saved value and presses Return when the button asks for it', async () => {
    const calls: string[][] = []
    const { lookup } = scopedLookup(instance([{ label: 'go', value: 'go', enter: true }]))
    const provider = createPastePadProvider(async (_f, args) => { calls.push(args.slice(1)); return '{"ok":true}' }, lookup, async () => {})

    const result = await provider.commands!.paste({ instanceId: 'pad-1', index: 0 }, { loopback: true })

    expect(result).toEqual({ ok: true })
    expect(calls).toEqual([['paste', 'go'], ['enter']])
  })

  it('threads the command context into the instance lookup — without it the scope check fails closed', async () => {
    const { lookup, box } = scopedLookup(instance([{ label: 'go', value: 'go' }]))
    const provider = createPastePadProvider(async () => '{"ok":true}', lookup, async () => {})

    const result = await provider.commands!.paste({ instanceId: 'pad-1', index: 0 }, { loopback: true })
    expect(result).toEqual({ ok: true })
    expect(box.sawCtx).toEqual({ loopback: true })
  })

  it('refuses non-local callers and unknown buttons before touching the keyboard', async () => {
    let calls = 0
    const { lookup } = scopedLookup(instance([{ label: 'go', value: 'go' }]))
    const provider = createPastePadProvider(async () => { calls++; return '{"ok":true}' }, lookup, async () => {})

    expect(await provider.commands!.paste({ instanceId: 'pad-1', index: 0 }, undefined)).toEqual({ ok: false, error: tr(undefined, 'provider.localOnly') })
    expect(await provider.commands!.paste({ instanceId: 'pad-1', index: 5 }, { loopback: true })).toEqual({ ok: false, error: tr(undefined, 'pastePad.unknownButton') })
    expect(calls).toBe(0)
  })

  it('reports a native failure instead of flashing success', async () => {
    const { lookup } = scopedLookup(instance([{ label: 'go', value: 'go' }]))
    const provider = createPastePadProvider(async () => '{"ok":false,"error":"unavailable"}', lookup, async () => {})

    const result = await provider.commands!.paste({ instanceId: 'pad-1', index: 0 }, { loopback: true })
    expect(result).toEqual({ ok: false, error: tr(undefined, 'pastePad.failed') })
  })
})
