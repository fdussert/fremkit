import { execFile } from 'node:child_process'
import type { CommandContext, Provider } from '../providers/types.js'
import { assertBundleId, type DockSnapshot, type DockState } from './state.js'
import { tr } from '../i18n.js'

const activateApp = (bundleId: string): Promise<void> =>
  new Promise((resolve, reject) => execFile('open', ['-b', bundleId], (err) => (err ? reject(err) : resolve())))

/**
 * The `dock` channel.
 *
 * The data is pushed by the helper, not fetched, so `poll` merely reads the state every second;
 * the registry publishes only when the JSON actually changed, which is what makes the
 * ten-second `available` flip reach the widget without a timer of its own.
 */
export function createDockProvider(state: DockState, deps: { activate?: (bundleId: string) => Promise<void> } = {}): Provider {
  const activate = deps.activate ?? activateApp
  return {
    channel: 'dock',
    intervalMs: 1000,
    poll: async (): Promise<DockSnapshot> => state.snapshot(),
    commands: {
      activate: async (payload, ctx?: CommandContext) => {
        // `activate` brings an app to the front of the user's Mac, so only a client on that Mac
        // may ask for it. Fail closed: a caller that provides no context is treated as remote,
        // so an older call site cannot quietly hand this command to the network.
        if (!ctx?.loopback) throw new Error(tr(undefined, 'provider.localOnly'))
        const bundleId = String((payload as { bundleId?: unknown })?.bundleId ?? '')
        assertBundleId(bundleId)
        await activate(bundleId)
        return { activated: bundleId }
      },
    },
  }
}
