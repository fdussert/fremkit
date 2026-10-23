import { execFile } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { Provider } from '../providers/types.js'
import { targetPlatform, windowsUserCandidates, WINDOWS_CHILD_ENV_KEYS, type Platform } from '../platform/index.js'

const Status = z.object({
  loggedIn: z.boolean(),
  authMethod: z.string().max(100).nullish(),
  subscriptionType: z.string().max(100).nullish(),
})

export interface ClaudeIdentity {
  loggedIn: boolean | null
  subscriptionType: string | null
  authMethod: string | null
  updatedAt: number | null
  stale: boolean
  error: 'offline' | 'invalid' | null
}

export function identityEnv(env: NodeJS.ProcessEnv, platform: Platform = targetPlatform()): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {}
  const keys = ['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'USER', 'LOGNAME', 'SHELL', 'CLAUDE_CONFIG_DIR']
  if (platform === 'win32') keys.push(...WINDOWS_CHILD_ENV_KEYS)
  for (const key of keys) {
    if (env[key] !== undefined) safe[key] = env[key]
  }
  return safe
}

/** Where the CLI is installed: the native installer's folders on Windows, a closed list. */
export function claudeCandidates(platform: Platform = targetPlatform(), env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform === 'win32') {
    return windowsUserCandidates([['USERPROFILE', '.local\\bin\\claude.exe'], ['LOCALAPPDATA', 'Programs\\claude\\claude.exe']], env)
  }
  return [join(homedir(), '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']
}

/** Resolve only known local installs; the helper's PATH need not contain the CLI. */
export async function resolveClaudeBinary(
  canExecute: (path: string) => Promise<void> = (path) => access(path, constants.X_OK),
  platform: Platform = targetPlatform(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const candidates = claudeCandidates(platform, env)
  for (const path of candidates) {
    try {
      await canExecute(path)
      return path
    } catch { /* Try the next fixed location. */ }
  }
  throw new Error('offline')
}

function readStatus(): Promise<string> {
  const env = identityEnv(process.env)
  env.USER ??= userInfo().username
  env.LOGNAME ??= env.USER
  return resolveClaudeBinary().then((binary) => new Promise((resolve, reject) => {
    execFile(binary, ['auth', 'status', '--json'], {
      env, cwd: homedir(), timeout: 10000, maxBuffer: 16384, shell: false,
    }, (error, stdout) => {
      if (!error || (error.code === 1 && stdout.trim().startsWith('{'))) resolve(stdout)
      else reject(new Error('offline'))
    })
  }))
}

function plan(type: string | null | undefined): string | null {
  return type === 'max' || type === 'pro' || type === 'team' || type === 'enterprise' ? type : null
}

export function createClaudeIdentityProvider(opts: {
  read?: () => Promise<string>
  now?: () => number
} = {}): Provider<ClaudeIdentity> {
  const read = opts.read ?? readStatus
  const now = opts.now ?? Date.now
  let last: ClaudeIdentity = {
    loggedIn: null, subscriptionType: null, authMethod: null,
    updatedAt: null, stale: false, error: null,
  }
  let generation = 0
  const provider: Provider<ClaudeIdentity> = {
    channel: 'claude-identity',
    intervalMs: 300000,
    stop() { generation++ },
    async poll() {
      const epoch = generation
      try {
        const status = Status.parse(JSON.parse(await read()))
        const next: ClaudeIdentity = {
          loggedIn: status.loggedIn,
          subscriptionType: status.loggedIn && status.authMethod === 'claude.ai' ? plan(status.subscriptionType) : null,
          authMethod: status.authMethod === 'claude.ai' || status.authMethod === 'api-key' ? status.authMethod : null,
          updatedAt: now(), stale: false, error: null,
        }
        if (epoch === generation) last = next
      } catch (error) {
        if (epoch === generation) last = {
          ...last, stale: true,
          error: error instanceof z.ZodError || error instanceof SyntaxError ? 'invalid' : 'offline',
        }
      }
      // The registry may reuse this provider after its last listener briefly leaves.
      // Its old in-flight read was discarded, so retry promptly on reactivation.
      provider.intervalMs = epoch !== generation ? 1 : last.error ? 30000 : 300000
      return last
    },
  }
  return provider
}
